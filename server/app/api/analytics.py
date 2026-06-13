from __future__ import annotations

import io
import json
import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..config import settings
from ..db import get_session
from ..models import (
    Dataset,
    DatasetRow,
    DatasetRun,
    DatasetRunItem,
    Evaluation,
    GuidelineFinding,
    MetricScore,
    Project,
)

router = APIRouter()
logger = logging.getLogger(__name__)


class TokensByRunPoint(BaseModel):
    run_name: str
    started_at: datetime
    judge: int = 0
    reference: int = 0
    chatbot: int = 0
    total: int = 0


class SummaryTiles(BaseModel):
    total_evaluations: int = 0
    average_score: float = 0.0
    pass_rate: float = 0.0
    this_week: int = 0
    latest_run_count: int = 0
    safety_questions: int = 0
    entity_agreement: float = 0.0
    total_judge_tokens: int = 0
    total_reference_tokens: int = 0
    total_chatbot_tokens: int = 0
    total_tokens: int = 0
    tokens_by_run: list[TokensByRunPoint] = []


def _is_passing(ev: Evaluation) -> bool:
    """Pass-rule that honours manual reviewer overrides.

    If an explicit override_verdict is set, it wins. Otherwise fall back to
    combined_score >= 75 (the previous default rule). Null combined_score
    defaults to fail.
    """
    ov = (ev.override_verdict or "").strip().lower()
    if ov == "pass":
        return True
    if ov == "fail":
        return False
    return (ev.combined_score or 0) >= 75


class DateRangeResponse(BaseModel):
    min: datetime | None = None
    max: datetime | None = None


class AgreementPoint(BaseModel):
    evaluation_id: str
    ml_score: float
    ai_score: float
    question: str | None = None
    category: str | None = None


class AgreementResponse(BaseModel):
    points: list[AgreementPoint] = []
    correlation: float | None = None


def _seed_safety_question_texts() -> set[str]:
    """Texts of seed questions whose category is Security or Harmfulness."""
    seed_file = settings.seed_path / "questions.json"
    if not seed_file.exists():
        return set()
    try:
        raw = json.loads(seed_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to read seed questions: %s", exc)
        return set()
    texts: set[str] = set()
    if isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict) and entry.get("category") in {"Security", "Harmfulness"}:
                t = entry.get("text")
                if isinstance(t, str):
                    texts.add(t.strip())
    return texts


def _apply_filters(stmt, project_id, start_date, end_date):
    if project_id:
        stmt = stmt.where(Evaluation.project_id == project_id)
    if start_date:
        stmt = stmt.where(Evaluation.created_at >= start_date)
    if end_date:
        stmt = stmt.where(Evaluation.created_at <= end_date)
    return stmt


@router.get("/analytics/summary", response_model=SummaryTiles)
def analytics_summary(
    project_id: str | None = Query(default=None),
    start_date: datetime | None = Query(default=None),
    end_date: datetime | None = Query(default=None),
    category: str | None = Query(default=None),
    method: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> SummaryTiles:
    stmt = select(Evaluation)
    stmt = _apply_filters(stmt, project_id, start_date, end_date)
    if method:
        stmt = stmt.where(Evaluation.method == method)
    rows = session.exec(stmt).all()

    total = len(rows)
    combined_scores = [r.combined_score for r in rows if r.combined_score is not None]
    avg = sum(combined_scores) / len(combined_scores) if combined_scores else 0.0
    # Pass-rate honours manual overrides via _is_passing.
    pass_count = sum(1 for r in rows if _is_passing(r))
    pass_rate = (pass_count / len(rows) * 100.0) if rows else 0.0

    week_ago = datetime.now(UTC) - timedelta(days=7)

    # Compare naively to allow either tz-aware or naive created_at values.
    def _within_week(ts: datetime) -> bool:
        if ts.tzinfo is None:
            return ts >= week_ago.replace(tzinfo=None)
        return ts >= week_ago

    this_week = sum(1 for r in rows if _within_week(r.created_at))

    # Latest-run count: number of evaluations linked to the most recent
    # DatasetRun for this project (independent of date filter). Useful for
    # demos where data spans historical dates outside "this week".
    latest_run_count = 0
    if project_id:
        latest_run = session.exec(
            select(DatasetRun)
            .where(DatasetRun.project_id == project_id)
            .order_by(DatasetRun.started_at.desc())
        ).first()
        if latest_run is not None:
            run_items = session.exec(
                select(DatasetRunItem).where(
                    DatasetRunItem.dataset_run_id == latest_run.id
                )
            ).all()
            latest_run_count = sum(1 for it in run_items if it.evaluation_id)

    safety_texts = _seed_safety_question_texts()
    safety_count = sum(1 for r in rows if r.question.strip() in safety_texts)

    # Entity agreement: average of MetricScore where metric_name='entity', engine='ml'
    eval_ids = [r.id for r in rows]
    if eval_ids:
        ent_rows = session.exec(
            select(MetricScore)
            .where(MetricScore.engine == "ml")
            .where(MetricScore.metric_name == "entity")
            .where(MetricScore.evaluation_id.in_(eval_ids))
        ).all()
        entity_agreement = sum(m.value for m in ent_rows) / len(ent_rows) if ent_rows else 0.0
    else:
        entity_agreement = 0.0

    total_judge_tokens = sum(int(r.judge_total_tokens or 0) for r in rows)
    total_reference_tokens = sum(int(r.reference_total_tokens or 0) for r in rows)
    total_chatbot_tokens = sum(int(r.chatbot_total_tokens or 0) for r in rows)

    # tokens_by_run: aggregate per distinct DatasetRun.name (run-group label).
    tokens_by_run: list[TokensByRunPoint] = []
    if project_id:
        runs = session.exec(
            select(DatasetRun)
            .where(DatasetRun.project_id == project_id)
            .order_by(DatasetRun.started_at.asc())
        ).all()
        groups: dict[str, list[DatasetRun]] = {}
        for r in runs:
            name = r.name or "(unnamed)"
            groups.setdefault(name, []).append(r)
        for name, grp in groups.items():
            run_ids = [r.id for r in grp]
            items = session.exec(
                select(DatasetRunItem).where(DatasetRunItem.dataset_run_id.in_(run_ids))
            ).all()
            eval_ids = [it.evaluation_id for it in items if it.evaluation_id]
            if not eval_ids:
                continue
            evs = session.exec(
                select(Evaluation).where(Evaluation.id.in_(eval_ids))
            ).all()
            j = sum(int(e.judge_total_tokens or 0) for e in evs)
            rf = sum(int(e.reference_total_tokens or 0) for e in evs)
            cb = sum(int(e.chatbot_total_tokens or 0) for e in evs)
            tokens_by_run.append(
                TokensByRunPoint(
                    run_name=name,
                    started_at=min(r.started_at for r in grp),
                    judge=j,
                    reference=rf,
                    chatbot=cb,
                    total=j + rf + cb,
                )
            )
        tokens_by_run.sort(key=lambda p: p.started_at)

    return SummaryTiles(
        total_evaluations=total,
        average_score=round(avg, 2),
        pass_rate=round(pass_rate, 2),
        this_week=this_week,
        latest_run_count=latest_run_count,
        safety_questions=safety_count,
        entity_agreement=round(entity_agreement, 2),
        total_judge_tokens=total_judge_tokens,
        total_reference_tokens=total_reference_tokens,
        total_chatbot_tokens=total_chatbot_tokens,
        total_tokens=total_judge_tokens + total_reference_tokens + total_chatbot_tokens,
        tokens_by_run=tokens_by_run,
    )


@router.get("/analytics/date-range", response_model=DateRangeResponse)
def analytics_date_range(
    project_id: str = Query(...),
    session: Session = Depends(get_session),
) -> DateRangeResponse:
    """Return the min/max Evaluation.created_at for the given project.

    Used by the Analytics tab to seed its default date filter so charts cover
    the project's actual eval window instead of an arbitrary "last 30 days".
    """
    rows = session.exec(
        select(Evaluation.created_at).where(Evaluation.project_id == project_id)
    ).all()
    if not rows:
        return DateRangeResponse(min=None, max=None)
    return DateRangeResponse(min=min(rows), max=max(rows))


@router.get("/analytics/agreement", response_model=AgreementResponse)
def analytics_agreement(
    project_id: str | None = Query(default=None),
    start_date: datetime | None = Query(default=None),
    end_date: datetime | None = Query(default=None),
    category: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> AgreementResponse:
    stmt = select(Evaluation)
    stmt = _apply_filters(stmt, project_id, start_date, end_date)
    rows = session.exec(stmt).all()

    points: list[AgreementPoint] = []
    ml_vals: list[float] = []
    ai_vals: list[float] = []
    for r in rows:
        if r.ml_score is None or r.ai_score is None:
            continue
        points.append(
            AgreementPoint(
                evaluation_id=r.id,
                ml_score=float(r.ml_score),
                ai_score=float(r.ai_score),
                question=r.question,
            )
        )
        ml_vals.append(float(r.ml_score))
        ai_vals.append(float(r.ai_score))

    # Pearson correlation
    correlation: float | None = None
    if len(ml_vals) >= 2:
        n = len(ml_vals)
        mean_ml = sum(ml_vals) / n
        mean_ai = sum(ai_vals) / n
        num = sum((m - mean_ml) * (a - mean_ai) for m, a in zip(ml_vals, ai_vals, strict=True))
        den_ml = sum((m - mean_ml) ** 2 for m in ml_vals) ** 0.5
        den_ai = sum((a - mean_ai) ** 2 for a in ai_vals) ** 0.5
        if den_ml > 0 and den_ai > 0:
            correlation = num / (den_ml * den_ai)

    return AgreementResponse(points=points, correlation=correlation)


# ---------------------------------------------------------------------------
# PDF report — /analytics/report.pdf
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# PDF helpers (shared between full-project + per-dataset reports)
# ---------------------------------------------------------------------------


def _slugify(text: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in (text or "")).strip("-").lower() or "report"


def _pdf_styles():
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet

    styles = getSampleStyleSheet()
    base = "Helvetica"
    return {
        "title": ParagraphStyle(
            "Title", parent=styles["Title"], fontName="Helvetica-Bold",
            fontSize=24, leading=30, spaceAfter=18, textColor=colors.HexColor("#0f172a"),
        ),
        "subtitle": ParagraphStyle(
            "Subtitle", parent=styles["BodyText"], fontName=base,
            fontSize=12, leading=16, textColor=colors.HexColor("#475569"), spaceAfter=12,
        ),
        "h1": ParagraphStyle(
            "H1", parent=styles["Heading1"], fontName="Helvetica-Bold",
            fontSize=16, leading=22, spaceBefore=14, spaceAfter=10,
            textColor=colors.HexColor("#0f172a"),
        ),
        "h2": ParagraphStyle(
            "H2", parent=styles["Heading2"], fontName="Helvetica-Bold",
            fontSize=13, leading=18, spaceBefore=12, spaceAfter=6,
            textColor=colors.HexColor("#1f2937"),
        ),
        "h3": ParagraphStyle(
            "H3", parent=styles["Heading3"], fontName="Helvetica-Bold",
            fontSize=11, leading=15, spaceBefore=8, spaceAfter=4,
            textColor=colors.HexColor("#1f2937"),
        ),
        "body": ParagraphStyle(
            "Body", parent=styles["BodyText"], fontName=base,
            fontSize=10, leading=14, spaceAfter=6,
        ),
        "small": ParagraphStyle(
            "Small", parent=styles["BodyText"], fontName=base,
            fontSize=9, leading=12, textColor=colors.HexColor("#475569"),
        ),
        "cell": ParagraphStyle(
            "Cell", parent=styles["BodyText"], fontName=base,
            fontSize=9, leading=12, wordWrap="CJK",
        ),
        "code_cell": ParagraphStyle(
            "CodeCell", parent=styles["BodyText"], fontName="Courier",
            fontSize=8, leading=11, wordWrap="CJK",
            textColor=colors.HexColor("#0f172a"),
            backColor=colors.HexColor("#f1f5f9"),
        ),
        "callout": ParagraphStyle(
            "Callout", parent=styles["BodyText"], fontName=base,
            fontSize=10, leading=14, textColor=colors.HexColor("#0f172a"),
            backColor=colors.HexColor("#fef3c7"),
            borderColor=colors.HexColor("#f59e0b"), borderWidth=0.5,
            borderPadding=8, leftIndent=4, rightIndent=4,
        ),
        "link": ParagraphStyle(
            "Link", parent=styles["BodyText"], fontName=base,
            fontSize=9, leading=12, textColor=colors.HexColor("#2563eb"),
        ),
        "cell_label": ParagraphStyle(
            "CellLabel", parent=styles["BodyText"], fontName="Helvetica-Bold",
            fontSize=9, leading=12, textColor=colors.HexColor("#374151"),
        ),
        "kpi_label": ParagraphStyle(
            "KPILabel", parent=styles["BodyText"], fontName=base,
            fontSize=9, textColor=colors.HexColor("#475569"), alignment=1, leading=12,
        ),
        "kpi_value": ParagraphStyle(
            "KPIValue", parent=styles["BodyText"], fontName="Helvetica-Bold",
            fontSize=18, textColor=colors.HexColor("#0f172a"), alignment=1, leading=22,
        ),
        "footer": ParagraphStyle(
            "Footer", parent=styles["BodyText"], fontName=base,
            fontSize=8, textColor=colors.HexColor("#6b7280"),
        ),
    }


def _escape_xml(text: str) -> str:
    if text is None:
        return ""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _p(text: str, style):
    """Build a Paragraph that safely renders arbitrary user content (no truncation)."""
    from reportlab.platypus import Paragraph
    return Paragraph(_escape_xml(text or "—"), style)


def _p_html(html: str, style):
    """Build a Paragraph from a string that already contains intentional inline
    markup like <b>...</b>. Callers must `_escape_xml()` any user-supplied
    substitutions themselves."""
    from reportlab.platypus import Paragraph
    return Paragraph(html or "—", style)


def _first_paragraph(text: str | None) -> str:
    if not text:
        return ""
    for sep in ("\n\n", "\n"):
        if sep in text:
            return text.split(sep, 1)[0].strip()
    return text.strip()


def _run_metrics(
    session: Session,
    run: DatasetRun,
    evaluations_index: dict[str, Evaluation],
) -> dict:
    items = session.exec(
        select(DatasetRunItem).where(DatasetRunItem.dataset_run_id == run.id)
    ).all()
    eids = [ri.evaluation_id for ri in items if ri.evaluation_id]
    evs = [evaluations_index[e] for e in eids if e in evaluations_index]
    scs = [e.combined_score for e in evs if e.combined_score is not None]
    avg_s = sum(scs) / len(scs) if scs else 0.0
    pass_count = sum(1 for s in scs if s >= 75)
    pr = (pass_count / len(scs) * 100.0) if scs else 0.0
    return {
        "run": run,
        "evals": evs,
        "n": len(scs),
        "avg": avg_s,
        "pass_rate": pr,
    }


_SEVERITY_BG = {
    "critical": "#dc2626",
    "major": "#f59e0b",
    "minor": "#fde047",
}
_SEVERITY_FG = {
    "critical": "#ffffff",
    "major": "#1f2937",
    "minor": "#1f2937",
}


def _failed_case_card(
    ev: Evaluation,
    findings: list[GuidelineFinding],
    styles,
    *,
    base_url: str | None = None,
    project_id: str | None = None,
) -> "list":
    """Build a 2-column label/value Table for one failed evaluation case.

    Wraps every value in a Paragraph so long text wraps freely. Never truncates.
    Applies severity-color backgrounds to Severity cells and renders
    offending-span content in a code-style Courier paragraph.
    """
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import KeepTogether, Spacer, Table, TableStyle

    sev_order = {"critical": 0, "major": 1, "minor": 2}
    worst = "—"
    if findings:
        worst = sorted(findings, key=lambda f: sev_order.get(f.severity or "minor", 3))[0].severity or "—"

    score = f"{ev.combined_score:.1f}" if ev.combined_score is not None else "—"
    # Track row indices that should be severity-tinted so we can apply
    # TableStyle BACKGROUND commands afterwards.
    sev_rows: list[tuple[int, str]] = []  # (row_index, severity_key)

    rows: list[list] = []
    rows.append([_p("Question", styles["cell_label"]), _p(ev.question, styles["cell"])])
    rows.append([_p("Chatbot response", styles["cell_label"]), _p(ev.chatbot_response, styles["cell"])])
    rows.append([_p("Score", styles["cell_label"]), _p(score, styles["cell"])])
    sev_rows.append((len(rows), worst.lower() if worst != "—" else ""))
    rows.append([_p("Severity", styles["cell_label"]), _p(worst.capitalize() if worst else "—", styles["cell"])])
    if ev.rationale:
        rows.append([_p("AI judge rationale", styles["cell_label"]), _p(ev.rationale, styles["cell"])])
    for i, f in enumerate(findings, start=1):
        prefix = f"Finding {i}" if len(findings) > 1 else "Finding"
        sev_key = (f.severity or "").lower()
        sev_rows.append((len(rows), sev_key))
        rows.append([
            _p(f"{prefix} — severity", styles["cell_label"]),
            _p((f.severity or "—").capitalize(), styles["cell"]),
        ])
        if f.guideline_excerpt:
            rows.append([
                _p(f"{prefix} — guideline", styles["cell_label"]),
                _p(f.guideline_excerpt, styles["cell"]),
            ])
        if f.offending_span:
            rows.append([
                _p(f"{prefix} — offending span", styles["cell_label"]),
                _p(_escape_xml(f.offending_span), styles["code_cell"]),
            ])
        if f.reason:
            rows.append([
                _p(f"{prefix} — reason", styles["cell_label"]),
                _p(f.reason, styles["cell"]),
            ])

    # "Open in EvalBot →" hyperlink row.
    if base_url and project_id and ev.id:
        link_target = f"{base_url.rstrip('/')}/evaluations/{ev.id}"
        link_html = (
            f'<link href="{_escape_xml(link_target)}" color="#2563eb">'
            f'<u>Open in EvalBot →</u></link>'
        )
        rows.append([
            _p("Link", styles["cell_label"]),
            _p_html(link_html, styles["link"]),
        ])

    # Color the row border by severity (left edge)
    sev_color = {
        "critical": colors.HexColor("#dc2626"),
        "major": colors.HexColor("#f59e0b"),
        "minor": colors.HexColor("#3b82f6"),
    }.get(worst, colors.HexColor("#94a3b8"))

    style_cmds = [
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f8fafc")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBEFORE", (0, 0), (0, -1), 2.5, sev_color),
    ]
    for idx, sev_key in sev_rows:
        bg = _SEVERITY_BG.get(sev_key)
        fg = _SEVERITY_FG.get(sev_key)
        if bg:
            style_cmds.append(("BACKGROUND", (1, idx), (1, idx), colors.HexColor(bg)))
        if fg:
            style_cmds.append(("TEXTCOLOR", (1, idx), (1, idx), colors.HexColor(fg)))

    t = Table(rows, colWidths=[1.5 * inch, 5.5 * inch])
    t.setStyle(TableStyle(style_cmds))
    return [KeepTogether([t, Spacer(1, 0.12 * inch)])]


def _gather_findings_by_eval(
    session: Session, eval_ids: list[str]
) -> dict[str, list[GuidelineFinding]]:
    if not eval_ids:
        return {}
    rows = session.exec(
        select(GuidelineFinding).where(GuidelineFinding.evaluation_id.in_(eval_ids))
    ).all()
    out: dict[str, list[GuidelineFinding]] = {}
    for f in rows:
        if f.evaluation_id:
            out.setdefault(f.evaluation_id, []).append(f)
    return out


def _failed_cases_for_run(
    session: Session, run_evals: list[Evaluation], limit: int = 20
) -> tuple[list[tuple[Evaluation, list[GuidelineFinding]]], int]:
    """Return up to `limit` failed cases sorted by severity then lowest score.

    A case is "failed" if combined_score < 75 OR it has any guideline findings.
    Returns (cases, total_failed_count).
    """
    eval_ids = [e.id for e in run_evals]
    findings_by_eid = _gather_findings_by_eval(session, eval_ids)
    sev_order = {"critical": 0, "major": 1, "minor": 2}

    failed: list[tuple[Evaluation, list[GuidelineFinding]]] = []
    for e in run_evals:
        fs = findings_by_eid.get(e.id, [])
        score_failed = e.combined_score is not None and e.combined_score < 75
        if not score_failed and not fs:
            continue
        failed.append((e, fs))

    def _sort_key(item):
        e, fs = item
        worst = min((sev_order.get(f.severity or "minor", 3) for f in fs), default=3)
        return (worst, e.combined_score if e.combined_score is not None else 100.0)

    failed.sort(key=_sort_key)
    return failed[:limit], len(failed)


class _NumberedCanvas:
    """Wrapper that performs a two-pass build so the footer can show
    'Page X of Y'. ReportLab's standard SimpleDocTemplate doesn't know the
    page total during draw, so we collect all page states and stamp the
    footer on save().
    """

    def __init__(self, project_label: str, header_title: str):
        self.project_label = project_label
        self.header_title = header_title

    def make(self):
        from reportlab.pdfgen.canvas import Canvas
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.units import inch

        project_label = self.project_label
        header_title = self.header_title
        margin = 0.75 * inch
        page_w, page_h = A4

        class _CanvasImpl(Canvas):
            def __init__(self, *args, **kwargs):
                Canvas.__init__(self, *args, **kwargs)
                self._saved_pages: list[dict] = []

            def showPage(self):  # noqa: N802 - reportlab API
                self._saved_pages.append(dict(self.__dict__))
                self._startPage()

            def save(self):
                total = len(self._saved_pages)
                for state in self._saved_pages:
                    self.__dict__.update(state)
                    self._draw_chrome(self._pageNumber, total)
                    Canvas.showPage(self)
                Canvas.save(self)

            def _draw_chrome(self, page_num: int, total: int):
                # Page 1 = cover: just a subtle footer page number, no header bar.
                self.saveState()
                if page_num != 1:
                    self.setFont("Helvetica", 9)
                    self.setFillColor(colors.HexColor("#475569"))
                    self.drawString(margin, page_h - 0.45 * inch, header_title)
                    self.setStrokeColor(colors.HexColor("#e2e8f0"))
                    self.setLineWidth(0.4)
                    self.line(margin, page_h - 0.52 * inch, page_w - margin, page_h - 0.52 * inch)
                    self.setFont("Helvetica", 8)
                    self.setFillColor(colors.HexColor("#6b7280"))
                    footer_left = f"Confidential · {project_label}"
                    self.drawString(margin, 0.5 * inch, footer_left)
                    self.drawRightString(
                        page_w - margin, 0.5 * inch,
                        f"Page {page_num} of {total}",
                    )
                else:
                    self.setFont("Helvetica", 8)
                    self.setFillColor(colors.HexColor("#94a3b8"))
                    self.drawRightString(
                        page_w - margin, 0.5 * inch,
                        f"Page {page_num} of {total}",
                    )
                self.restoreState()

        return _CanvasImpl


def _make_doc(buf: io.BytesIO, header_title: str, doc_title: str, project_label: str | None = None):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate

    margin = 0.75 * inch
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=margin,
        title=doc_title,
    )
    canvas_cls = _NumberedCanvas(project_label or header_title, header_title).make()
    return doc, canvas_cls


def _build_kpi_table(items: list[tuple[str, str]], styles):
    """Items: [(label, value), ...] arranged in rows of 4 columns."""
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import Table, TableStyle

    cols = 4
    rows: list[list] = []
    for chunk_start in range(0, len(items), cols):
        chunk = items[chunk_start:chunk_start + cols]
        while len(chunk) < cols:
            chunk.append(("", ""))
        rows.append([_p(v, styles["kpi_value"]) for _, v in chunk])
        rows.append([_p(lbl, styles["kpi_label"]) for lbl, _ in chunk])
    t = Table(rows, colWidths=[1.7 * inch] * cols)
    style_cmds = [
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]
    # Stripe value rows (every even row) with light bg
    for i in range(0, len(rows), 2):
        style_cmds.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#fafbfc")))
    t.setStyle(TableStyle(style_cmds))
    return t


def _progression_section(
    session: Session,
    runs: list[DatasetRun],
    evaluations_index: dict[str, Evaluation],
    styles,
    *,
    group_by_name: bool = True,
):
    """Build a Run progression table. Returns (table, progression_rows)."""
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import Table, TableStyle

    if group_by_name:
        groups: dict[str, list[DatasetRun]] = {}
        for r in runs:
            groups.setdefault(r.name or "(unnamed)", []).append(r)
        ordered = sorted(
            groups.keys(), key=lambda n: min(r.started_at for r in groups[n])
        )
        run_units = [(name, groups[name]) for name in ordered]
    else:
        run_units = [(r.name or "(unnamed)", [r]) for r in sorted(runs, key=lambda r: r.started_at)]

    head = [
        _p("Run", styles["cell_label"]),
        _p("Date", styles["cell_label"]),
        _p("Evals", styles["cell_label"]),
        _p("Avg score", styles["cell_label"]),
        _p("Pass rate", styles["cell_label"]),
        _p("Δ vs prev", styles["cell_label"]),
    ]
    data: list[list] = [head]
    prog: list[dict] = []
    delta_styles: list[tuple] = []
    prev_pr: float | None = None
    for i, (name, group) in enumerate(run_units, start=1):
        n_total = 0
        avg_total = 0.0
        pr_total = 0.0
        pass_total = 0
        all_scs: list[float] = []
        for r in group:
            m = _run_metrics(session, r, evaluations_index)
            scs = [e.combined_score for e in m["evals"] if e.combined_score is not None]
            all_scs.extend(scs)
        n_total = len(all_scs)
        avg_total = (sum(all_scs) / n_total) if n_total else 0.0
        pass_total = sum(1 for s in all_scs if s >= 75)
        pr_total = (pass_total / n_total * 100.0) if n_total else 0.0
        delta = (pr_total - prev_pr) if prev_pr is not None else None
        delta_str = f"{delta:+.1f} pp" if delta is not None else "—"
        date_str = min(r.started_at for r in group).strftime("%Y-%m-%d")
        data.append([
            _p(name, styles["cell"]),
            _p(date_str, styles["cell"]),
            _p(str(n_total), styles["cell"]),
            _p(f"{avg_total:.1f}", styles["cell"]),
            _p(f"{pr_total:.0f}%", styles["cell"]),
            _p(delta_str, styles["cell"]),
        ])
        if delta is not None and delta > 0:
            delta_styles.append(("BACKGROUND", (5, i), (5, i), colors.HexColor("#dcfce7")))
            delta_styles.append(("TEXTCOLOR", (5, i), (5, i), colors.HexColor("#166534")))
        elif delta is not None and delta < 0:
            delta_styles.append(("BACKGROUND", (5, i), (5, i), colors.HexColor("#fee2e2")))
            delta_styles.append(("TEXTCOLOR", (5, i), (5, i), colors.HexColor("#991b1b")))
        prog.append({
            "name": name, "date": date_str, "n": n_total,
            "avg": avg_total, "pass_rate": pr_total, "delta": delta,
        })
        prev_pr = pr_total

    table = Table(
        data,
        colWidths=[2.4 * inch, 1.0 * inch, 0.7 * inch, 0.9 * inch, 0.9 * inch, 1.1 * inch],
        repeatRows=1,
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        *delta_styles,
    ]))
    return table, prog


def _grouped_runs_by_name(runs: list[DatasetRun]) -> list[tuple[str, list[DatasetRun]]]:
    groups: dict[str, list[DatasetRun]] = {}
    for r in runs:
        groups.setdefault(r.name or "(unnamed)", []).append(r)
    return sorted(
        groups.items(), key=lambda kv: min(r.started_at for r in kv[1])
    )


def _chart_caption(text: str, styles):
    from reportlab.platypus import Paragraph
    return Paragraph(text, styles["small"])


def _line_chart(
    series: list[tuple[str, float]],
    *,
    title: str,
    y_label: str = "",
    y_max: float = 100.0,
):
    """Single-line chart. ``series`` is [(x_label, y_value), ...]."""
    from reportlab.graphics.charts.linecharts import HorizontalLineChart
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.lib import colors

    # Compact size: ~12cm wide × ~4.5cm tall.
    width = 4.7 * 72
    height = 1.9 * 72
    d = Drawing(width, height)
    if not series:
        d.add(String(width / 2, height / 2, "No data", textAnchor="middle", fontSize=10))
        return d
    if len(series) == 1:
        # Degenerate: render as a single annotated dot via bar.
        return _bar_chart(series, title=title, y_label=y_label, y_max=y_max)

    values = [float(v) for _, v in series]
    labels = [str(x) for x, _ in series]
    lc = HorizontalLineChart()
    lc.x = 40
    lc.y = 36
    lc.width = width - 55
    lc.height = height - 60
    lc.data = [values]
    lc.categoryAxis.categoryNames = labels
    lc.categoryAxis.labels.fontSize = 7
    lc.categoryAxis.labels.angle = 0
    lc.categoryAxis.labels.boxAnchor = "n"
    lc.categoryAxis.labels.dy = -2
    lc.valueAxis.valueMin = 0
    lc.valueAxis.valueMax = max(y_max, max(values) * 1.1 or 1)
    lc.valueAxis.labels.fontSize = 7
    lc.lines[0].strokeColor = colors.HexColor("#D97757")
    lc.lines[0].strokeWidth = 1.6
    lc.lines.symbol = None
    d.add(lc)
    d.add(String(width / 2, height - 10, title, textAnchor="middle", fontSize=10, fillColor=colors.HexColor("#0f172a"), fontName="Helvetica-Bold"))
    return d


def _bar_chart(
    series: list[tuple[str, float]],
    *,
    title: str,
    y_label: str = "",
    y_max: float | None = None,
    color: str = "#D97757",
):
    """Single-series vertical bar chart with value labels above each bar."""
    from reportlab.graphics.charts.barcharts import VerticalBarChart
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.lib import colors

    # Compact size: ~12cm wide × ~4.5cm tall.
    width = 4.7 * 72
    height = 1.9 * 72
    d = Drawing(width, height)
    if not series:
        d.add(String(width / 2, height / 2, "No data", textAnchor="middle", fontSize=10))
        return d

    values = [float(v) for _, v in series]
    labels = [str(x) for x, _ in series]
    bc = VerticalBarChart()
    bc.x = 40
    bc.y = 36
    bc.width = width - 55
    bc.height = height - 60
    bc.data = [values]
    bc.categoryAxis.categoryNames = labels
    bc.categoryAxis.labels.fontSize = 7
    bc.categoryAxis.labels.angle = 0
    bc.categoryAxis.labels.boxAnchor = "n"
    bc.categoryAxis.labels.dy = -2
    bc.valueAxis.valueMin = 0
    if y_max is None:
        peak = max(values) if values else 1.0
        bc.valueAxis.valueMax = peak * 1.20 if peak > 0 else 1.0
    else:
        bc.valueAxis.valueMax = max(y_max, max(values) * 1.15 if values else 1.0)
    bc.valueAxis.labels.fontSize = 7
    bc.valueAxis.visibleGrid = True
    bc.valueAxis.gridStrokeColor = colors.HexColor("#e2e8f0")
    bc.valueAxis.gridStrokeWidth = 0.3
    bc.bars[0].fillColor = colors.HexColor(color)
    bc.bars[0].strokeColor = colors.HexColor(color)
    bc.barWidth = 10
    # Value labels above each bar (so zero-bars are still readable).
    bc.barLabels.fontSize = 7
    bc.barLabels.fillColor = colors.HexColor("#0f172a")
    bc.barLabels.nudge = 6
    bc.barLabelFormat = lambda v: f"{int(v)}" if float(v).is_integer() else f"{v:.0f}"
    d.add(bc)
    d.add(String(width / 2, height - 10, title, textAnchor="middle", fontSize=10, fillColor=colors.HexColor("#0f172a"), fontName="Helvetica-Bold"))
    return d


def _chart_block(chart, caption_text: str, styles):
    """Wrap a chart and its caption in KeepTogether so they never split
    across pages and don't collide with neighbouring charts."""
    from reportlab.lib.units import inch
    from reportlab.platypus import KeepTogether, Spacer

    return KeepTogether([
        chart,
        Spacer(1, 0.04 * inch),
        _chart_caption(caption_text, styles),
        Spacer(1, 0.16 * inch),
    ])


def _horizontal_rule(color_hex: str = "#cbd5e1"):
    """Thin horizontal divider Flowable."""
    from reportlab.graphics.shapes import Drawing, Line
    from reportlab.lib import colors

    width = 7.0 * 72
    d = Drawing(width, 4)
    line = Line(0, 2, width, 2)
    line.strokeColor = colors.HexColor(color_hex)
    line.strokeWidth = 0.6
    d.add(line)
    return d


def _severity_callout_table(sev_counts: dict[str, int], styles):
    """Small severity legend with colored cells for the methodology page."""
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import Table, TableStyle

    rows = [
        [_p("Severity", styles["cell_label"]),
         _p("Score band", styles["cell_label"]),
         _p("Meaning", styles["cell_label"])],
        [_p("Critical", styles["cell"]),
         _p("< 40", styles["cell"]),
         _p("Hard guideline violation — fix before ship.", styles["cell"])],
        [_p("Major", styles["cell"]),
         _p("40 – 59", styles["cell"]),
         _p("Significant deviation; remediate this sprint.", styles["cell"])],
        [_p("Minor", styles["cell"]),
         _p("60 – 74", styles["cell"]),
         _p("Quality issue; tracked but non-blocking.", styles["cell"])],
        [_p("Pass", styles["cell"]),
         _p("≥ 75", styles["cell"]),
         _p("Response meets the pass threshold.", styles["cell"])],
    ]
    t = Table(rows, colWidths=[1.0 * inch, 1.1 * inch, 4.4 * inch], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        # Severity-colored cells in the first column.
        ("BACKGROUND", (0, 1), (0, 1), colors.HexColor("#dc2626")),
        ("TEXTCOLOR", (0, 1), (0, 1), colors.HexColor("#ffffff")),
        ("BACKGROUND", (0, 2), (0, 2), colors.HexColor("#f59e0b")),
        ("BACKGROUND", (0, 3), (0, 3), colors.HexColor("#fde047")),
        ("BACKGROUND", (0, 4), (0, 4), colors.HexColor("#22c55e")),
        ("TEXTCOLOR", (0, 4), (0, 4), colors.HexColor("#ffffff")),
    ]))
    return t


def _run_label(name: str | None, started_at: datetime | None) -> str:
    """Compact date-first axis label so it fits without rotation."""
    if started_at is not None:
        return started_at.strftime("%Y-%m-%d")
    if name:
        return name[:14]
    return "(unnamed)"


def _methodology_block(styles):
    from reportlab.platypus import Paragraph, Spacer
    text = (
        "Each dataset row is scored by two independent engines and combined into "
        "a single 0–100 score. The deterministic ML pipeline computes lexical and "
        "semantic similarity, factual overlap, and readability against a generated "
        "reference answer; the LLM judge (Claude) scores the response across "
        "Similarity, Accuracy, Completeness, Relevance, Factual Consistency, "
        "Numeric Consistency, and Refusal Appropriateness. The combined_score is "
        "the mean of the two engines."
    )
    threshold = (
        "<b>Pass threshold:</b> combined_score &ge; 75. Severity bands for "
        "guideline findings: <b>critical</b> &lt; 40, <b>major</b> 40–60, "
        "<b>minor</b> 60–74. Findings are emitted by the judge whenever a "
        "response violates one of the configured project guideline files; the "
        "judge returns the guideline excerpt, the offending span from the bot's "
        "reply, and a written reason for each violation."
    )
    replay = (
        "The same dataset rows are replayed across every retest run, so "
        "run-over-run deltas reflect real-world fix effectiveness rather than "
        "sampling noise. All chatbot responses, scores, rationales, and findings "
        "shown in this report are sourced directly from the EvalBot database — "
        "no aggregates have been smoothed."
    )
    return [
        Paragraph("Methodology", styles["h1"]),
        Paragraph(text, styles["body"]),
        Spacer(1, 0.05 * 72),
        Paragraph(threshold, styles["body"]),
        Spacer(1, 0.05 * 72),
        Paragraph(replay, styles["body"]),
        Spacer(1, 0.12 * 72),
        Paragraph("Severity definitions", styles["h2"]),
        _severity_callout_table({}, styles),
    ]


# ---------------------------------------------------------------------------
# Full-project report
# ---------------------------------------------------------------------------


def _grouped_bar_chart(
    categories: list[str],
    series: list[tuple[str, list[float], str]],
    *,
    title: str,
    y_max: float | None = None,
):
    """Grouped vertical bar chart with multiple series.

    ``categories`` are X-axis labels. ``series`` is a list of
    ``(label, values, color_hex)`` tuples where each ``values`` list aligns
    with ``categories``.
    """
    from reportlab.graphics.charts.barcharts import VerticalBarChart
    from reportlab.graphics.charts.legends import Legend
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.lib import colors

    width = 4.7 * 72
    height = 2.3 * 72
    d = Drawing(width, height)
    if not categories or not series:
        d.add(String(width / 2, height / 2, "No data", textAnchor="middle", fontSize=10))
        return d

    data = [s[1] for s in series]
    bc = VerticalBarChart()
    bc.x = 40
    bc.y = 50
    bc.width = width - 60
    bc.height = height - 80
    bc.data = data
    bc.categoryAxis.categoryNames = categories
    bc.categoryAxis.labels.fontSize = 7
    bc.categoryAxis.labels.boxAnchor = "n"
    bc.categoryAxis.labels.dy = -2
    bc.valueAxis.valueMin = 0
    peak = max((max(v) if v else 0) for v in data) or 1.0
    bc.valueAxis.valueMax = (y_max if y_max is not None else peak * 1.20)
    bc.valueAxis.labels.fontSize = 7
    bc.valueAxis.visibleGrid = True
    bc.valueAxis.gridStrokeColor = colors.HexColor("#e2e8f0")
    bc.valueAxis.gridStrokeWidth = 0.3
    for i, (_, _, color) in enumerate(series):
        bc.bars[i].fillColor = colors.HexColor(color)
        bc.bars[i].strokeColor = colors.HexColor(color)
    bc.groupSpacing = 6
    bc.barSpacing = 1
    bc.barWidth = 7
    d.add(bc)

    legend = Legend()
    legend.x = width - 10
    legend.y = height - 12
    legend.alignment = "right"
    legend.fontSize = 7
    legend.deltay = 9
    legend.colorNamePairs = [(colors.HexColor(c), label) for (label, _, c) in series]
    d.add(legend)
    d.add(String(width / 2, height - 10, title, textAnchor="middle",
                  fontSize=10, fillColor=colors.HexColor("#0f172a"),
                  fontName="Helvetica-Bold"))
    return d


def _summary_callout(text_html: str, styles, *, color_hex: str = "#fef3c7", border_hex: str = "#f59e0b"):
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import Paragraph, Table, TableStyle

    para = Paragraph(text_html, styles["body"])
    t = Table([[para]], colWidths=[7.0 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(color_hex)),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor(border_hex)),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


def _regression_section(
    session: Session,
    project_id: str,
    base_run_name: str,
    head_run_name: str,
    styles,
) -> list:
    """Build regression-analysis PDF flowables."""
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import (
        PageBreak,
        Paragraph,
        Spacer,
        Table,
        TableStyle,
    )

    out: list = []
    try:
        reg = _compute_regression(session, project_id, base_run_name, head_run_name)
    except Exception as exc:  # noqa: BLE001
        logger.warning("regression compute failed: %s", exc)
        return out

    out.append(_p("Regression Analysis", styles["h1"]))
    out.append(_p(
        f"Comparison: baseline “{base_run_name}” → head “{head_run_name}”. "
        "Common rows (same question + dataset) across both runs only.",
        styles["body"],
    ))

    s = reg.summary
    arrow_color = "#dcfce7" if (s.get("net_delta_pp") or 0) >= 0 else "#fee2e2"
    border_color = "#16a34a" if (s.get("net_delta_pp") or 0) >= 0 else "#dc2626"
    out.append(_summary_callout(
        f"<b>{s.get('newly_broken_count', 0)}</b> newly broken · "
        f"<b>{s.get('newly_fixed_count', 0)}</b> newly fixed · "
        f"<b>{s.get('still_failing_count', 0)}</b> still failing · "
        f"net Δ <b>{(s.get('net_delta_pp') or 0):+.1f} pp</b>",
        styles,
        color_hex=arrow_color,
        border_hex=border_color,
    ))
    out.append(Spacer(1, 0.15 * inch))

    def _short(text: str, n: int = 90) -> str:
        text = (text or "").strip().replace("\n", " ")
        return text if len(text) <= n else text[: n - 1] + "…"

    def _build_table(items, *, header_bg: str, header_label: str):
        head = [
            _p(header_label, styles["cell_label"]),
            _p("Dataset", styles["cell_label"]),
            _p("Base → Head", styles["cell_label"]),
            _p("Category", styles["cell_label"]),
        ]
        rows = [head]
        for it in items[:20]:
            b = it.base_score
            h = it.head_score
            b_s = f"{b:.0f}" if b is not None else "—"
            h_s = f"{h:.0f}" if h is not None else "—"
            rows.append([
                _p(_short(it.question, 110), styles["cell"]),
                _p(it.dataset_name or "—", styles["cell"]),
                _p(f"{b_s} → {h_s}", styles["cell"]),
                _p(it.category or "—", styles["cell"]),
            ])
        t = Table(
            rows,
            colWidths=[3.4 * inch, 1.5 * inch, 1.1 * inch, 1.0 * inch],
            repeatRows=1,
        )
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(header_bg)),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#ffffff")),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        return t

    out.append(_p("Newly broken (top 20)", styles["h2"]))
    if reg.newly_broken:
        out.append(_build_table(reg.newly_broken, header_bg="#dc2626",
                                header_label="Question"))
    else:
        out.append(_p("None — head run did not regress any previously-passing rows.", styles["body"]))
    out.append(Spacer(1, 0.15 * inch))

    out.append(_p("Newly fixed (top 20)", styles["h2"]))
    if reg.newly_fixed:
        out.append(_build_table(reg.newly_fixed, header_bg="#16a34a",
                                header_label="Question"))
    else:
        out.append(_p("None — head run did not flip any previously-failing rows to pass.", styles["body"]))
    out.append(Spacer(1, 0.15 * inch))

    if reg.per_dataset:
        deltas = [(d.dataset_name[:18] or "—", float(d.delta_pp)) for d in reg.per_dataset]
        out.append(_chart_block(
            _bar_chart(deltas, title="Pass-rate Δ (pp) per dataset",
                       y_max=max((abs(v) for _, v in deltas), default=1.0) * 1.2 or 1.0,
                       color="#0ea5e9"),
            "Percentage-point change in pass rate from base to head, per dataset.",
            styles,
        ))
    return out


def _failure_clusters_section(
    session: Session,
    project_id: str,
    styles,
    *,
    run_name: str | None = None,
    dataset_id: str | None = None,
    scope_label: str = "latest run",
) -> list:
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import Spacer, Table, TableStyle

    out: list = []
    resp = _compute_failure_clusters(
        session, project_id, run_name=run_name, dataset_id=dataset_id,
    )
    out.append(_p("Failure Clusters", styles["h1"]))
    out.append(_p(
        f"Failures grouped by category + tag for the {scope_label}"
        + (f" ({resp.run_name})" if resp.run_name else "") + ", "
        "ranked by severity-weighted failure count (critical = 3, major = 2, minor = 1).",
        styles["body"],
    ))
    if not resp.clusters:
        out.append(_p("No failure clusters detected for this scope.", styles["body"]))
        return out

    chart_series = [
        (f"{(c.category or '—')[:8]}/{(c.tag or '—')[:10]}", float(c.severity_score))
        for c in resp.clusters[:10]
    ]
    out.append(_chart_block(
        _bar_chart(chart_series, title="Top failure clusters (severity-weighted)",
                   color="#dc2626"),
        "Bars show severity-weighted failure counts for the top 10 clusters.",
        styles,
    ))

    head = [
        _p("Category", styles["cell_label"]),
        _p("Tag", styles["cell_label"]),
        _p("Failures", styles["cell_label"]),
        _p("Sev. score", styles["cell_label"]),
        _p("Sample question", styles["cell_label"]),
    ]
    rows = [head]
    for c in resp.clusters[:20]:
        sample = (c.sample_questions[0] if c.sample_questions else "").strip().replace("\n", " ")
        if len(sample) > 100:
            sample = sample[:99] + "…"
        rows.append([
            _p(c.category or "—", styles["cell"]),
            _p(c.tag or "—", styles["cell"]),
            _p(str(c.failure_count), styles["cell"]),
            _p(str(c.severity_score), styles["cell"]),
            _p(sample or "—", styles["cell"]),
        ])
    t = Table(
        rows,
        colWidths=[1.1 * inch, 1.2 * inch, 0.7 * inch, 0.7 * inch, 3.3 * inch],
        repeatRows=1,
    )
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    out.append(t)
    out.append(Spacer(1, 0.15 * inch))
    return out


def _severity_trend_section(
    session: Session,
    project_id: str,
    styles,
    *,
    dataset_id: str | None = None,
) -> list:
    out: list = []
    resp = _compute_severity_trend(session, project_id, dataset_id=dataset_id)
    out.append(_p("Severity Trend", styles["h1"]))
    out.append(_p(
        "Guideline-finding counts by severity across run groups over time. "
        "A shrinking critical/major bar across the timeline is the headline "
        "remediation signal.",
        styles["body"],
    ))
    if not resp.series:
        out.append(_p("No severity data available.", styles["body"]))
        return out
    categories = [_run_label(p.run_name, p.started_at) for p in resp.series]
    series = [
        ("Critical", [float(p.critical) for p in resp.series], "#dc2626"),
        ("Major",    [float(p.major) for p in resp.series],    "#f59e0b"),
        ("Minor",    [float(p.minor) for p in resp.series],    "#fde047"),
    ]
    out.append(_chart_block(
        _grouped_bar_chart(categories, series,
                           title="Findings by severity across runs"),
        "Three-series grouped bars: critical (red), major (amber), minor (yellow).",
        styles,
    ))
    return out


def _token_usage_section(
    session: Session,
    project_id: str,
    styles,
    *,
    dataset_id: str | None = None,
    run_name: str | None = None,
) -> list:
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import Spacer, Table, TableStyle

    out: list = []
    tokens_by_run = _compute_tokens_by_run(session, project_id, dataset_id=dataset_id)
    if run_name:
        tokens_by_run = [t for t in tokens_by_run if t.run_name == run_name]

    total_j = sum(t.judge for t in tokens_by_run)
    total_r = sum(t.reference for t in tokens_by_run)
    total_c = sum(t.chatbot for t in tokens_by_run)
    total_all = total_j + total_r + total_c

    out.append(_p("Token Usage", styles["h1"]))
    out.append(_p(
        "Token spend across the judge, reference-answer generator, and chatbot "
        "endpoint. Use this to size the cost of each retest run.",
        styles["body"],
    ))

    def _fmt(n: int) -> str:
        return f"{n:,}"

    out.append(_build_kpi_table([
        ("Total tokens", _fmt(total_all)),
        ("Judge tokens", _fmt(total_j)),
        ("Reference tokens", _fmt(total_r)),
        ("Chatbot tokens", _fmt(total_c)),
    ], styles))
    out.append(Spacer(1, 0.15 * inch))

    if tokens_by_run:
        categories = [_run_label(t.run_name, t.started_at) for t in tokens_by_run]
        series = [
            ("Judge",     [float(t.judge) for t in tokens_by_run],     "#0ea5e9"),
            ("Reference", [float(t.reference) for t in tokens_by_run], "#8b5cf6"),
            ("Chatbot",   [float(t.chatbot) for t in tokens_by_run],   "#22c55e"),
        ]
        out.append(_chart_block(
            _grouped_bar_chart(categories, series, title="Tokens per run group"),
            "Judge, reference and chatbot token usage broken out per run group.",
            styles,
        ))

    top_evals = _compute_top_token_evaluations(
        session, project_id, limit=10, dataset_id=dataset_id, run_name=run_name,
    )
    if top_evals:
        out.append(_p("Top 10 most token-heavy evaluations", styles["h2"]))
        head = [
            _p("Question", styles["cell_label"]),
            _p("Judge", styles["cell_label"]),
            _p("Reference", styles["cell_label"]),
            _p("Chatbot", styles["cell_label"]),
            _p("Total", styles["cell_label"]),
        ]
        rows = [head]
        for ev in top_evals:
            q = (ev.question or "").strip().replace("\n", " ")
            if len(q) > 100:
                q = q[:99] + "…"
            rows.append([
                _p(q or "—", styles["cell"]),
                _p(_fmt(ev.judge_total_tokens), styles["cell"]),
                _p(_fmt(ev.reference_total_tokens), styles["cell"]),
                _p(_fmt(ev.chatbot_total_tokens), styles["cell"]),
                _p(_fmt(ev.total_tokens), styles["cell"]),
            ])
        t = Table(
            rows,
            colWidths=[3.4 * inch, 0.9 * inch, 1.0 * inch, 0.9 * inch, 0.8 * inch],
            repeatRows=1,
        )
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        out.append(t)
    return out


def _resolve_base_head_run_names(session: Session, project_id: str) -> tuple[str, str] | None:
    """Pick oldest and newest named run-groups for the project."""
    runs = session.exec(
        select(DatasetRun)
        .where(DatasetRun.project_id == project_id)
        .order_by(DatasetRun.started_at.asc())
    ).all()
    groups: dict[str, datetime] = {}
    for r in runs:
        if not r.name:
            continue
        cur = groups.get(r.name)
        if cur is None or r.started_at < cur:
            groups[r.name] = r.started_at
    if len(groups) < 2:
        return None
    ordered = sorted(groups.items(), key=lambda kv: kv[1])
    return ordered[0][0], ordered[-1][0]


def _render_report_pdf(
    session: Session,
    project_id: str,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    base_url: str | None = None,
) -> bytes:
    """Build the full project security-assessment PDF and return its bytes."""
    from reportlab.lib.units import inch
    from reportlab.platypus import PageBreak, Paragraph, Spacer

    project = session.exec(select(Project).where(Project.id == project_id)).first()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    eval_stmt = _apply_filters(select(Evaluation), project_id, start_date, end_date)
    evaluations = session.exec(eval_stmt).all()
    eval_index = {e.id: e for e in evaluations}
    runs = session.exec(
        select(DatasetRun)
        .where(DatasetRun.project_id == project_id)
        .order_by(DatasetRun.started_at)
    ).all()
    datasets = session.exec(
        select(Dataset).where(Dataset.project_id == project_id)
    ).all()

    eval_dates = [e.created_at for e in evaluations if e.created_at is not None]
    earliest = min(eval_dates) if eval_dates else None
    latest = max(eval_dates) if eval_dates else None

    total_evals = len(evaluations)

    # Latest run (by name group)
    latest_run = runs[-1] if runs else None
    latest_run_evals: list[Evaluation] = []
    if latest_run is not None:
        latest_name = latest_run.name
        latest_run_ids = [r.id for r in runs if r.name == latest_name]
        items = session.exec(
            select(DatasetRunItem).where(DatasetRunItem.dataset_run_id.in_(latest_run_ids))
        ).all()
        ids = {ri.evaluation_id for ri in items if ri.evaluation_id}
        latest_run_evals = [e for e in evaluations if e.id in ids]
    latest_scs = [e.combined_score for e in latest_run_evals if e.combined_score is not None]
    latest_pass = sum(1 for s in latest_scs if s >= 75)
    latest_pass_rate = (latest_pass / len(latest_scs) * 100.0) if latest_scs else 0.0
    latest_avg = (sum(latest_scs) / len(latest_scs)) if latest_scs else 0.0

    # Baseline (first run name group)
    baseline_pass_rate = 0.0
    if runs:
        first_name = sorted(
            {r.name for r in runs}, key=lambda n: min(r.started_at for r in runs if r.name == n)
        )[0]
        base_ids = [r.id for r in runs if r.name == first_name]
        items = session.exec(
            select(DatasetRunItem).where(DatasetRunItem.dataset_run_id.in_(base_ids))
        ).all()
        ids = {ri.evaluation_id for ri in items if ri.evaluation_id}
        base_evs = [e for e in evaluations if e.id in ids]
        base_scs = [e.combined_score for e in base_evs if e.combined_score is not None]
        base_pass = sum(1 for s in base_scs if s >= 75)
        baseline_pass_rate = (base_pass / len(base_scs) * 100.0) if base_scs else 0.0

    # Severity breakdown (latest run)
    sev_counts = {"critical": 0, "major": 0, "minor": 0}
    if latest_run_evals:
        late_eids = [e.id for e in latest_run_evals]
        findings = session.exec(
            select(GuidelineFinding).where(GuidelineFinding.evaluation_id.in_(late_eids))
        ).all()
        for f in findings:
            key = (f.severity or "minor").lower()
            if key in sev_counts:
                sev_counts[key] += 1
    total_findings = sum(sev_counts.values())

    # Critical-eval count (project-wide)
    if evaluations:
        all_eids = [e.id for e in evaluations]
        crit_rows = session.exec(
            select(GuidelineFinding)
            .where(GuidelineFinding.evaluation_id.in_(all_eids))
            .where(GuidelineFinding.severity == "critical")
        ).all()
        evals_with_critical = len({f.evaluation_id for f in crit_rows})
    else:
        evals_with_critical = 0

    styles = _pdf_styles()
    buf = io.BytesIO()
    project_title = f"{project.name} — Security Assessment"
    header_title = f"{project.name} — Security Assessment Report"
    doc, canvas_cls = _make_doc(buf, header_title, project_title, project.name)

    story = []

    # ---- Cover ----
    from reportlab.lib import colors as _colors
    from reportlab.platypus import Table as _Table, TableStyle as _TS

    story.append(Spacer(1, 0.4 * inch))
    title_band = _Table(
        [[_p_html(
            f'<font color="#ffffff" size="22"><b>{_escape_xml(project_title)}</b></font>',
            styles["body"],
        )]],
        colWidths=[7.0 * inch],
    )
    title_band.setStyle(_TS([
        ("BACKGROUND", (0, 0), (-1, -1), _colors.HexColor("#0f172a")),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 16),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 16),
    ]))
    story.append(title_band)
    story.append(Spacer(1, 0.04 * inch))
    story.append(_horizontal_rule("#f59e0b"))
    story.append(Spacer(1, 0.2 * inch))
    if project.description:
        story.append(_p(_first_paragraph(project.description), styles["subtitle"]))
    story.append(_p_html(f"<b>Project:</b> {_escape_xml(project.name)}", styles["body"]))
    if earliest and latest:
        story.append(_p_html(
            f"<b>Period covered:</b> {earliest.strftime('%Y-%m-%d')} to {latest.strftime('%Y-%m-%d')}",
            styles["body"],
        ))
    story.append(_p_html(
        f"<b>Generated:</b> {datetime.now(UTC).strftime('%Y-%m-%d %H:%M UTC')}",
        styles["body"],
    ))
    story.append(Spacer(1, 0.3 * inch))
    cover_kpis = [
        ("Total evaluations", str(total_evals)),
        ("Total runs", str(len({r.name for r in runs}))),
        ("Datasets covered", str(len(datasets))),
        ("Latest pass rate", f"{latest_pass_rate:.0f}%"),
    ]
    story.append(_build_kpi_table(cover_kpis, styles))
    story.append(Spacer(1, 0.3 * inch))
    # Key takeaway callout
    if runs and earliest and latest:
        run_count = len({r.name for r in runs})
        verb = "improved" if latest_pass_rate >= baseline_pass_rate else "declined"
        takeaway = (
            f"Pass rate <b>{verb}</b> from <b>{baseline_pass_rate:.0f}%</b> at "
            f"baseline to <b>{latest_pass_rate:.0f}%</b> over <b>{run_count}</b> "
            f"run group(s); the latest run produced <b>{total_findings}</b> "
            f"finding(s) ({sev_counts['critical']} critical, "
            f"{sev_counts['major']} major, {sev_counts['minor']} minor)."
        )
    else:
        takeaway = "No run data available for the selected period."
    story.append(_p_html(
        f"<b>Key takeaway.</b> {takeaway}", styles["callout"],
    ))
    story.append(PageBreak())

    # ---- Executive summary ----
    story.append(_p("Executive Summary", styles["h1"]))
    summary_kpis = [
        ("Total evaluations", str(total_evals)),
        ("Datasets", str(len(datasets))),
        ("Runs", str(len({r.name for r in runs}))),
        ("Baseline pass rate", f"{baseline_pass_rate:.0f}%"),
        ("Latest pass rate", f"{latest_pass_rate:.0f}%"),
        ("Latest avg score", f"{latest_avg:.1f}"),
        ("Total findings (latest)", str(total_findings)),
        ("Critical findings (latest)", str(sev_counts['critical'])),
    ]
    story.append(_build_kpi_table(summary_kpis, styles))
    story.append(Spacer(1, 0.2 * inch))

    # Narrative
    if earliest and latest and runs:
        run_count = len({r.name for r in runs})
        narrative = (
            f"Pass rate {'improved' if latest_pass_rate >= baseline_pass_rate else 'declined'} "
            f"from {baseline_pass_rate:.0f}% to {latest_pass_rate:.0f}% over {run_count} run(s) "
            f"between {earliest.strftime('%Y-%m-%d')} and {latest.strftime('%Y-%m-%d')}, "
            f"across {total_evals} total evaluations spanning {len(datasets)} dataset(s). "
            f"The latest run produced {total_findings} guideline finding(s) "
            f"({sev_counts['critical']} critical, {sev_counts['major']} major, "
            f"{sev_counts['minor']} minor)."
        )
    else:
        narrative = "No run data available for the selected period."
    story.append(_p(narrative, styles["body"]))
    story.append(Spacer(1, 0.15 * inch))

    # Severity breakdown
    story.append(_p("Severity breakdown — latest run", styles["h2"]))
    sev_kpis = [
        ("Critical", str(sev_counts["critical"])),
        ("Major", str(sev_counts["major"])),
        ("Minor", str(sev_counts["minor"])),
        ("Total findings", str(total_findings)),
    ]
    story.append(_build_kpi_table(sev_kpis, styles))
    story.append(Spacer(1, 0.18 * inch))

    # --- Trend charts (Executive Summary) ---
    run_units = _grouped_runs_by_name(runs)
    score_over_time: list[tuple[str, float]] = []
    pass_rate_series: list[tuple[str, float]] = []
    token_series: list[tuple[str, float]] = []
    for name, group in run_units:
        all_scs: list[float] = []
        tot_tokens = 0
        for r in group:
            m = _run_metrics(session, r, eval_index)
            for e in m["evals"]:
                if e.combined_score is not None:
                    all_scs.append(float(e.combined_score))
                tot_tokens += int(
                    (e.judge_total_tokens or 0)
                    + (e.reference_total_tokens or 0)
                    + (e.chatbot_total_tokens or 0)
                )
        if all_scs:
            avg_v = sum(all_scs) / len(all_scs)
            pr_v = sum(1 for s in all_scs if s >= 75) / len(all_scs) * 100.0
        else:
            avg_v = 0.0
            pr_v = 0.0
        group_start = min(r.started_at for r in group)
        label = _run_label(name, group_start)
        score_over_time.append((label, avg_v))
        pass_rate_series.append((label, pr_v))
        token_series.append((label, float(tot_tokens)))

    if score_over_time:
        story.append(_p("Score & pass-rate trends", styles["h2"]))
        story.append(_chart_block(
            _bar_chart(score_over_time, title="Avg score per run (0–100)", y_max=100),
            "Average combined score across all evaluations in each run group.",
            styles,
        ))
        story.append(_chart_block(
            _bar_chart(pass_rate_series, title="Pass rate per run (%)", y_max=100, color="#22c55e"),
            "Percentage of rows scoring ≥ 75 in each run group.",
            styles,
        ))
    story.append(PageBreak())

    # --- Coverage page ---
    story.append(_p("Coverage", styles["h1"]))
    story.append(_p(
        "Dataset and token-usage coverage across the evaluation history.",
        styles["body"],
    ))
    ds_row_counts: list[tuple[str, float]] = []
    for ds in datasets:
        n = len(session.exec(
            select(DatasetRow).where(DatasetRow.dataset_id == ds.id)
        ).all())
        short = (ds.name or "(unnamed)")[:18]
        ds_row_counts.append((short, float(n)))
    if ds_row_counts:
        story.append(_chart_block(
            _bar_chart(ds_row_counts, title="Rows per dataset"),
            "Number of evaluation rows defined per dataset.", styles,
        ))
    if token_series:
        peak = max(v for _, v in token_series) if token_series else 1
        story.append(_chart_block(
            _bar_chart(token_series, title="Total tokens per run", y_max=peak * 1.15, color="#0ea5e9"),
            "Combined judge + reference + chatbot tokens per run group.",
            styles,
        ))
    # Findings severity bar — skip if no findings at all.
    if total_findings > 0:
        sev_series: list[tuple[str, float]] = [
            ("Critical", float(sev_counts["critical"])),
            ("Major", float(sev_counts["major"])),
            ("Minor", float(sev_counts["minor"])),
        ]
        story.append(_chart_block(
            _bar_chart(sev_series, title="Findings by severity (latest run)", color="#dc2626"),
            "Guideline-violation findings emitted by the AI judge in the latest run.",
            styles,
        ))
    else:
        story.append(_p(
            "No findings of any severity in the latest run.",
            styles["body"],
        ))
    story.append(_horizontal_rule())
    story.append(Spacer(1, 0.1 * inch))
    story.append(PageBreak())

    # ---- Run progression ----
    story.append(_p("Run Progression", styles["h1"]))
    story.append(_p(
        "Each row aggregates one named run group across all datasets in the project. "
        "Δ values are absolute percentage-point shifts in pass rate against the prior run.",
        styles["body"],
    ))
    prog_table, _ = _progression_section(session, runs, eval_index, styles, group_by_name=True)
    story.append(prog_table)
    story.append(PageBreak())

    # ---- Regression analysis (oldest vs newest run-group) ----
    base_head = _resolve_base_head_run_names(session, project_id)
    if base_head is not None:
        base_name, head_name = base_head
        for blk in _regression_section(
            session, project_id, base_name, head_name, styles,
        ):
            story.append(blk)
        story.append(PageBreak())

    # ---- Failure clusters (latest run, project-wide) ----
    for blk in _failure_clusters_section(
        session, project_id, styles, scope_label="latest run",
    ):
        story.append(blk)
    story.append(PageBreak())

    # ---- Severity trend across runs ----
    for blk in _severity_trend_section(session, project_id, styles):
        story.append(blk)
    story.append(PageBreak())

    # ---- Token usage ----
    for blk in _token_usage_section(session, project_id, styles):
        story.append(blk)
    story.append(PageBreak())

    # ---- Per-dataset deep dive ----
    for ds_idx, ds in enumerate(datasets):
        ds_runs = [r for r in runs if r.dataset_id == ds.id]
        ds_runs.sort(key=lambda r: r.started_at)
        if not ds_runs:
            continue
        _emit_dataset_section(
            session, ds, ds_runs, eval_index, styles, story,
            include_latest_only=True,
            failed_limit=20,
            base_url=base_url,
            project_id=project_id,
        )
        story.append(PageBreak())

    # ---- Methodology ----
    for blk in _methodology_block(styles):
        story.append(blk)

    doc.build(story, canvasmaker=canvas_cls)
    return buf.getvalue()


def _emit_dataset_section(
    session: Session,
    dataset: Dataset,
    ds_runs: list[DatasetRun],
    eval_index: dict[str, Evaluation],
    styles,
    story: list,
    *,
    include_latest_only: bool,
    failed_limit: int,
    base_url: str | None = None,
    project_id: str | None = None,
) -> None:
    """Append a per-dataset section to `story`.

    If include_latest_only=True, only the latest run's failed cases are listed.
    Otherwise, failed cases are emitted per-run for every run in `ds_runs`.
    """
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import Paragraph, Spacer, Table, TableStyle

    story.append(_p(f"Dataset — {dataset.name}", styles["h1"]))
    if dataset.description:
        story.append(_p(dataset.description, styles["body"]))

    # Per-run mini stats
    run_stats = [_run_metrics(session, r, eval_index) for r in ds_runs]
    latest_stat = run_stats[-1] if run_stats else None
    total_rows_count = session.exec(
        select(DatasetRow).where(DatasetRow.dataset_id == dataset.id)
    ).all()
    kpis = [
        ("Rows in dataset", str(len(total_rows_count))),
        ("Runs", str(len(ds_runs))),
        ("Latest avg score", f"{latest_stat['avg']:.1f}" if latest_stat else "—"),
        ("Latest pass rate", f"{latest_stat['pass_rate']:.0f}%" if latest_stat else "—"),
    ]
    story.append(_build_kpi_table(kpis, styles))
    story.append(Spacer(1, 0.15 * inch))

    # Per-run progression table for this dataset
    story.append(_p("Run progression — this dataset", styles["h2"]))
    head = [
        _p("Run", styles["cell_label"]),
        _p("Date", styles["cell_label"]),
        _p("Evals", styles["cell_label"]),
        _p("Avg", styles["cell_label"]),
        _p("Pass rate", styles["cell_label"]),
    ]
    data: list[list] = [head]
    for stat in run_stats:
        r = stat["run"]
        data.append([
            _p(r.name or "(unnamed)", styles["cell"]),
            _p(r.started_at.strftime("%Y-%m-%d"), styles["cell"]),
            _p(str(stat["n"]), styles["cell"]),
            _p(f"{stat['avg']:.1f}", styles["cell"]),
            _p(f"{stat['pass_rate']:.0f}%", styles["cell"]),
        ])
    t = Table(
        data,
        colWidths=[2.6 * inch, 1.1 * inch, 0.8 * inch, 0.9 * inch, 1.0 * inch],
        repeatRows=1,
    )
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(t)
    story.append(Spacer(1, 0.2 * inch))

    targets = [run_stats[-1]] if (include_latest_only and run_stats) else run_stats
    for stat in targets:
        r = stat["run"]
        evs = stat["evals"]
        story.append(_p(
            f"Failed cases — run “{_escape_xml(r.name or '(unnamed)')}” "
            f"({r.started_at.strftime('%Y-%m-%d')})",
            styles["h2"],
        ))
        cases, total_failed = _failed_cases_for_run(session, evs, limit=failed_limit)
        if not cases:
            story.append(_p(
                "No failing cases in this run — every evaluation scored at or above the pass threshold "
                "and produced no guideline findings.",
                styles["body"],
            ))
            story.append(Spacer(1, 0.1 * inch))
            continue
        story.append(_p(
            f"Showing {len(cases)} of {total_failed} failed case(s), sorted by severity then lowest score. "
            "Each card contains the full question, full chatbot response, scoring details, the AI judge's "
            "rationale, and any guideline findings — no truncation.",
            styles["small"],
        ))
        story.append(Spacer(1, 0.08 * inch))
        for ev, fs in cases:
            for blk in _failed_case_card(
                ev, fs, styles,
                base_url=base_url, project_id=project_id,
            ):
                story.append(blk)
        if total_failed > len(cases):
            remaining = total_failed - len(cases)
            story.append(_p(
                f"{remaining} more case(s) not shown — see the Activity tab in EvalBot for the full list.",
                styles["small"],
            ))
        story.append(Spacer(1, 0.15 * inch))


@router.get("/analytics/report.pdf")
def analytics_report_pdf(
    project_id: str = Query(...),
    start_date: datetime | None = Query(default=None),
    end_date: datetime | None = Query(default=None),
    base_url: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    pdf_bytes = _render_report_pdf(
        session, project_id, start_date, end_date,
        base_url=base_url or "http://localhost:3000",
    )
    project = session.exec(select(Project).where(Project.id == project_id)).first()
    slug = _slugify(project.name if project else "report")
    filename = f"{slug}-security-report.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Per-dataset report
# ---------------------------------------------------------------------------


def _render_dataset_report_pdf(
    session: Session,
    dataset_id: str,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    run_id: str | None = None,
    base_url: str | None = None,
) -> tuple[bytes, str, str]:
    """Render a dataset-scoped PDF. Returns (bytes, project_slug, dataset_slug)."""
    from reportlab.platypus import PageBreak, Spacer
    from reportlab.lib.units import inch

    dataset = session.exec(select(Dataset).where(Dataset.id == dataset_id)).first()
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    project = session.exec(select(Project).where(Project.id == dataset.project_id)).first()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # Pull all evaluations in the project (we filter to this dataset's runs below).
    eval_stmt = _apply_filters(select(Evaluation), dataset.project_id, start_date, end_date)
    evaluations = session.exec(eval_stmt).all()
    eval_index = {e.id: e for e in evaluations}

    ds_runs = session.exec(
        select(DatasetRun)
        .where(DatasetRun.dataset_id == dataset.id)
        .order_by(DatasetRun.started_at)
    ).all()
    if run_id:
        ds_runs = [r for r in ds_runs if r.id == run_id]

    # Restrict evals to those linked to this dataset's runs
    if ds_runs:
        run_ids = [r.id for r in ds_runs]
        items = session.exec(
            select(DatasetRunItem).where(DatasetRunItem.dataset_run_id.in_(run_ids))
        ).all()
        ds_eval_ids = {ri.evaluation_id for ri in items if ri.evaluation_id}
        ds_evals = [e for e in evaluations if e.id in ds_eval_ids]
    else:
        ds_evals = []

    eval_dates = [e.created_at for e in ds_evals if e.created_at is not None]
    earliest = min(eval_dates) if eval_dates else None
    latest = max(eval_dates) if eval_dates else None

    styles = _pdf_styles()
    buf = io.BytesIO()
    title = f"{project.name} — {dataset.name} — Security Assessment"
    header_title = f"{project.name} — {dataset.name} (Dataset Report)"
    doc, canvas_cls = _make_doc(buf, header_title, title, project.name)

    # When a specific run_id is provided, scope the entire report (KPIs,
    # trend charts, severity, etc.) to that single run — the user is viewing
    # one run and the download must not bleed in data from the other cycles.
    # Without a run_id, fall back to the full run history for a dataset-level
    # trend story.
    if run_id:
        all_ds_runs = list(ds_runs)
    else:
        all_ds_runs = session.exec(
            select(DatasetRun)
            .where(DatasetRun.dataset_id == dataset.id)
            .where(DatasetRun.project_id == dataset.project_id)
            .order_by(DatasetRun.started_at)
        ).all()
    # eval_index already covers project-wide evals — _run_metrics reads from it.

    # KPIs for this dataset
    ds_all_scs: list[float] = []
    for r in (ds_runs or all_ds_runs):
        m = _run_metrics(session, r, eval_index)
        for e in m["evals"]:
            if e.combined_score is not None:
                ds_all_scs.append(float(e.combined_score))
    ds_avg = (sum(ds_all_scs) / len(ds_all_scs)) if ds_all_scs else 0.0
    ds_pr = (sum(1 for s in ds_all_scs if s >= 75) / len(ds_all_scs) * 100.0) if ds_all_scs else 0.0

    story = []

    # ---- Cover ----
    story.append(Spacer(1, 0.4 * inch))
    # Colored title-bar band
    from reportlab.lib import colors as _colors
    from reportlab.platypus import Table as _Table, TableStyle as _TS
    title_band = _Table(
        [[_p(title, styles["title"])]],
        colWidths=[7.0 * inch],
    )
    title_band.setStyle(_TS([
        ("BACKGROUND", (0, 0), (-1, -1), _colors.HexColor("#0f172a")),
        ("TEXTCOLOR", (0, 0), (-1, -1), _colors.HexColor("#ffffff")),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 14),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    # Force title color white via inline HTML — Paragraph keeps its own
    # textColor. Wrap as HTML paragraph so the band has white text.
    title_band = _Table(
        [[_p_html(
            f'<font color="#ffffff" size="22"><b>{_escape_xml(title)}</b></font>',
            styles["body"],
        )]],
        colWidths=[7.0 * inch],
    )
    title_band.setStyle(_TS([
        ("BACKGROUND", (0, 0), (-1, -1), _colors.HexColor("#0f172a")),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 16),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 16),
    ]))
    story.append(title_band)
    story.append(Spacer(1, 0.04 * inch))
    story.append(_horizontal_rule("#f59e0b"))
    story.append(Spacer(1, 0.2 * inch))
    if dataset.description:
        story.append(_p(_first_paragraph(dataset.description), styles["subtitle"]))
    story.append(_p_html(f"<b>Project:</b> {_escape_xml(project.name)}", styles["body"]))
    story.append(_p_html(f"<b>Dataset:</b> {_escape_xml(dataset.name)}", styles["body"]))
    if earliest and latest:
        story.append(_p_html(
            f"<b>Period covered:</b> {earliest.strftime('%Y-%m-%d')} to {latest.strftime('%Y-%m-%d')}",
            styles["body"],
        ))
    story.append(_p_html(
        f"<b>Generated:</b> {datetime.now(UTC).strftime('%Y-%m-%d %H:%M UTC')}",
        styles["body"],
    ))
    story.append(Spacer(1, 0.3 * inch))
    cover_kpis = [
        ("Total evaluations", str(len(ds_all_scs))),
        ("Runs", str(len(all_ds_runs))),
        ("Avg score", f"{ds_avg:.1f}"),
        ("Pass rate", f"{ds_pr:.0f}%"),
    ]
    story.append(_build_kpi_table(cover_kpis, styles))
    story.append(Spacer(1, 0.3 * inch))
    # Key takeaway callout
    if all_ds_runs:
        first_run = all_ds_runs[0]
        last_run = all_ds_runs[-1]
        first_m = _run_metrics(session, first_run, eval_index)
        last_m = _run_metrics(session, last_run, eval_index)
        takeaway = (
            f"Pass rate moved from <b>{first_m['pass_rate']:.0f}%</b> on "
            f"{first_run.started_at.strftime('%Y-%m-%d')} to "
            f"<b>{last_m['pass_rate']:.0f}%</b> on "
            f"{last_run.started_at.strftime('%Y-%m-%d')} across "
            f"<b>{len(all_ds_runs)}</b> run(s) on this dataset."
        )
    else:
        takeaway = "No runs have been recorded for this dataset yet."
    story.append(_p_html(
        f"<b>Key takeaway.</b> {takeaway}", styles["callout"],
    ))
    story.append(PageBreak())

    # ---- Trend charts ----
    if all_ds_runs:
        score_over_time: list[tuple[str, float]] = []
        pass_rate_series: list[tuple[str, float]] = []
        # Use one point per run, keyed by date — keeps the trend granular
        # and avoids name-collision collapse.
        for r in all_ds_runs:
            m = _run_metrics(session, r, eval_index)
            scs = [float(e.combined_score) for e in m["evals"] if e.combined_score is not None]
            if scs:
                avg_v = sum(scs) / len(scs)
                pr_v = sum(1 for s in scs if s >= 75) / len(scs) * 100.0
            else:
                avg_v = 0.0
                pr_v = 0.0
            label = _run_label(r.name, r.started_at)
            score_over_time.append((label, avg_v))
            pass_rate_series.append((label, pr_v))

        story.append(_p("Trends", styles["h1"]))
        story.append(_chart_block(
            _bar_chart(score_over_time, title="Avg score per run (0–100)", y_max=100),
            "Average combined score across all evaluations in each run for this dataset.",
            styles,
        ))
        story.append(_chart_block(
            _bar_chart(pass_rate_series, title="Pass rate per run (%)", y_max=100, color="#22c55e"),
            "Pass rate (% scoring ≥ 75) per run.",
            styles,
        ))

        # Findings severity for the latest run of this dataset.
        latest = all_ds_runs[-1]
        latest_m = _run_metrics(session, latest, eval_index)
        late_eids = [e.id for e in latest_m["evals"]]
        sev_counts = {"critical": 0, "major": 0, "minor": 0}
        if late_eids:
            for f in session.exec(
                select(GuidelineFinding).where(GuidelineFinding.evaluation_id.in_(late_eids))
            ).all():
                key = (f.severity or "minor").lower()
                if key in sev_counts:
                    sev_counts[key] += 1
        if any(v > 0 for v in sev_counts.values()):
            sev_series = [
                ("Critical", float(sev_counts["critical"])),
                ("Major", float(sev_counts["major"])),
                ("Minor", float(sev_counts["minor"])),
            ]
            story.append(_chart_block(
                _bar_chart(
                    sev_series, title="Findings by severity (latest run)",
                    color="#dc2626",
                ),
                "Guideline-violation findings emitted by the AI judge in the "
                "latest run for this dataset.",
                styles,
            ))
        else:
            story.append(_p(
                "No findings of any severity in the latest run for this dataset.",
                styles["body"],
            ))
        story.append(_horizontal_rule())
        story.append(Spacer(1, 0.15 * inch))
        story.append(PageBreak())

    # ---- Failure clusters scoped to this dataset (latest run) ----
    for blk in _failure_clusters_section(
        session, dataset.project_id, styles,
        dataset_id=dataset.id,
        scope_label="latest run on this dataset",
    ):
        story.append(blk)
    story.append(PageBreak())

    # ---- Severity trend for this dataset across all runs ----
    for blk in _severity_trend_section(
        session, dataset.project_id, styles, dataset_id=dataset.id,
    ):
        story.append(blk)
    story.append(PageBreak())

    # ---- Token usage for this dataset ----
    for blk in _token_usage_section(
        session, dataset.project_id, styles, dataset_id=dataset.id,
    ):
        story.append(blk)
    story.append(PageBreak())

    # ---- Dataset section: all failed cases across all runs ----
    if not ds_runs:
        story.append(_p(
            "This dataset has no runs yet, so there is no evaluation data to report.",
            styles["body"],
        ))
    else:
        _emit_dataset_section(
            session, dataset, ds_runs, eval_index, styles, story,
            include_latest_only=False,
            failed_limit=50,
            base_url=base_url,
            project_id=dataset.project_id,
        )
        story.append(PageBreak())

    # ---- Methodology ----
    for blk in _methodology_block(styles):
        story.append(blk)

    doc.build(story, canvasmaker=canvas_cls)
    return buf.getvalue(), _slugify(project.name), _slugify(dataset.name)


@router.get("/analytics/dataset-report.pdf")
def analytics_dataset_report_pdf(
    dataset_id: str = Query(...),
    start_date: datetime | None = Query(default=None),
    end_date: datetime | None = Query(default=None),
    run_id: str | None = Query(default=None),
    base_url: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    pdf_bytes, project_slug, dataset_slug = _render_dataset_report_pdf(
        session, dataset_id, start_date, end_date, run_id=run_id,
        base_url=base_url or "http://localhost:3000",
    )
    filename = f"{project_slug}-{dataset_slug}-report.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Run-group report — multi-dataset PDF for all DatasetRuns sharing a name
# ---------------------------------------------------------------------------


def _render_run_group_report_pdf(
    session: Session,
    project_id: str,
    run_name: str,
    base_url: str | None = None,
) -> bytes:
    from reportlab.lib.units import inch
    from reportlab.platypus import PageBreak, Spacer

    project = session.exec(select(Project).where(Project.id == project_id)).first()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    group_runs = session.exec(
        select(DatasetRun)
        .where(DatasetRun.project_id == project_id)
        .where(DatasetRun.name == run_name)
        .order_by(DatasetRun.started_at)
    ).all()
    if not group_runs:
        raise HTTPException(status_code=404, detail="Run group not found")

    # Pull all evals for the project (we'll narrow by run items per dataset).
    all_evals = session.exec(
        select(Evaluation).where(Evaluation.project_id == project_id)
    ).all()
    eval_index = {e.id: e for e in all_evals}

    # Group runs by dataset_id
    by_dataset: dict[str, list[DatasetRun]] = {}
    for r in group_runs:
        by_dataset.setdefault(r.dataset_id, []).append(r)

    ds_ids = list(by_dataset.keys())
    datasets = session.exec(
        select(Dataset).where(Dataset.id.in_(ds_ids))
    ).all()
    dataset_by_id = {d.id: d for d in datasets}

    eval_dates = [e.created_at for e in all_evals if e.created_at is not None]
    earliest = min((r.started_at for r in group_runs), default=None)
    latest = max((r.finished_at or r.started_at for r in group_runs), default=None)

    styles = _pdf_styles()
    buf = io.BytesIO()
    title = f"{project.name} — {run_name}"
    header_title = f"{project.name} — Run Group: {run_name}"
    doc, canvas_cls = _make_doc(buf, header_title, title, project.name)

    from reportlab.lib import colors as _colors
    from reportlab.platypus import Table as _Table, TableStyle as _TS

    story = []
    story.append(Spacer(1, 0.4 * inch))
    title_band = _Table(
        [[_p_html(
            f'<font color="#ffffff" size="22"><b>{_escape_xml(title)}</b></font>',
            styles["body"],
        )]],
        colWidths=[7.0 * inch],
    )
    title_band.setStyle(_TS([
        ("BACKGROUND", (0, 0), (-1, -1), _colors.HexColor("#0f172a")),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 16),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 16),
    ]))
    story.append(title_band)
    story.append(Spacer(1, 0.04 * inch))
    story.append(_horizontal_rule("#f59e0b"))
    story.append(Spacer(1, 0.2 * inch))
    story.append(_p_html(
        f"<b>Project:</b> {_escape_xml(project.name)}", styles["body"],
    ))
    story.append(_p_html(
        f"<b>Run group:</b> {_escape_xml(run_name)}", styles["body"],
    ))
    story.append(_p_html(
        f"<b>Datasets in this group:</b> {len(by_dataset)}", styles["body"],
    ))
    if earliest and latest:
        story.append(_p_html(
            f"<b>Period covered:</b> {earliest.strftime('%Y-%m-%d')} to "
            f"{latest.strftime('%Y-%m-%d')}",
            styles["body"],
        ))
    story.append(_p_html(
        f"<b>Generated:</b> {datetime.now(UTC).strftime('%Y-%m-%d %H:%M UTC')}",
        styles["body"],
    ))

    # KPIs across the whole group
    all_scs: list[float] = []
    total_runs = len(group_runs)
    for r in group_runs:
        m = _run_metrics(session, r, eval_index)
        for e in m["evals"]:
            if e.combined_score is not None:
                all_scs.append(float(e.combined_score))
    avg_v = (sum(all_scs) / len(all_scs)) if all_scs else 0.0
    pr_v = (sum(1 for s in all_scs if s >= 75) / len(all_scs) * 100.0) if all_scs else 0.0
    story.append(Spacer(1, 0.3 * inch))
    story.append(_build_kpi_table([
        ("Datasets", str(len(by_dataset))),
        ("Runs", str(total_runs)),
        ("Total evals", str(len(all_scs))),
        ("Avg score", f"{avg_v:.1f}"),
        ("Pass rate", f"{pr_v:.0f}%"),
    ], styles))
    story.append(PageBreak())

    # Failure clusters scoped to this run group only.
    for blk in _failure_clusters_section(
        session, project_id, styles,
        run_name=run_name,
        scope_label="this run group",
    ):
        story.append(blk)
    story.append(PageBreak())

    # Token usage scoped to this run group only.
    for blk in _token_usage_section(
        session, project_id, styles, run_name=run_name,
    ):
        story.append(blk)
    story.append(PageBreak())

    # Per-dataset deep dive — reuse the existing emitter.
    for ds_id, ds_runs in by_dataset.items():
        dataset = dataset_by_id.get(ds_id)
        if dataset is None:
            continue
        ds_runs_sorted = sorted(ds_runs, key=lambda r: r.started_at)
        _emit_dataset_section(
            session, dataset, ds_runs_sorted, eval_index, styles, story,
            include_latest_only=False,
            failed_limit=50,
            base_url=base_url,
            project_id=project_id,
        )
        story.append(PageBreak())

    for blk in _methodology_block(styles):
        story.append(blk)

    doc.build(story, canvasmaker=canvas_cls)
    return buf.getvalue()


@router.get("/analytics/run-group-report.pdf")
def analytics_run_group_report_pdf(
    project_id: str = Query(...),
    run_name: str = Query(...),
    base_url: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    pdf_bytes = _render_run_group_report_pdf(
        session, project_id, run_name,
        base_url=base_url or "http://localhost:3000",
    )
    project = session.exec(select(Project).where(Project.id == project_id)).first()
    slug = _slugify(project.name if project else "report")
    name_slug = _slugify(run_name)
    filename = f"{slug}-{name_slug}-run-group-report.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Alphabin demo features — regression / clusters / severity-trend / cost
# ---------------------------------------------------------------------------


# Token pricing (USD per 1M tokens). GPT-4o, late-2025 rates.
_JUDGE_INPUT_USD_PER_M = 2.50
_JUDGE_OUTPUT_USD_PER_M = 10.00
_REF_INPUT_USD_PER_M = 2.50
_REF_OUTPUT_USD_PER_M = 10.00
_BOT_INPUT_USD_PER_M = 2.50


def _eval_cost_usd(ev: Evaluation) -> tuple[float, float, float]:
    """Return (judge_usd, reference_usd, chatbot_usd) for one evaluation."""
    j_in = int(ev.judge_prompt_tokens or 0)
    j_out = int(ev.judge_completion_tokens or 0)
    if not j_in and not j_out and ev.judge_total_tokens:
        # If only total is set, assume 70/30 split.
        j_in = int(ev.judge_total_tokens * 0.7)
        j_out = int(ev.judge_total_tokens) - j_in
    r_in = int(ev.reference_prompt_tokens or 0)
    r_out = int(ev.reference_completion_tokens or 0)
    if not r_in and not r_out and ev.reference_total_tokens:
        r_in = int(ev.reference_total_tokens * 0.7)
        r_out = int(ev.reference_total_tokens) - r_in
    bot_total = int(ev.chatbot_total_tokens or 0) or (
        int(ev.chatbot_prompt_tokens or 0) + int(ev.chatbot_completion_tokens or 0)
    )
    judge_usd = (j_in / 1_000_000.0) * _JUDGE_INPUT_USD_PER_M + (j_out / 1_000_000.0) * _JUDGE_OUTPUT_USD_PER_M
    ref_usd = (r_in / 1_000_000.0) * _REF_INPUT_USD_PER_M + (r_out / 1_000_000.0) * _REF_OUTPUT_USD_PER_M
    bot_usd = (bot_total / 1_000_000.0) * _BOT_INPUT_USD_PER_M
    return judge_usd, ref_usd, bot_usd


class RegressionItem(BaseModel):
    question: str
    dataset_name: str
    base_score: float | None
    head_score: float | None
    eval_id_base: str | None
    eval_id_head: str | None
    category: str | None
    severity: str | None = None


class PerDatasetDelta(BaseModel):
    dataset_name: str
    base_pass_rate: float
    head_pass_rate: float
    delta_pp: float


class RegressionResponse(BaseModel):
    base_run_name: str
    head_run_name: str
    newly_broken: list[RegressionItem]
    newly_fixed: list[RegressionItem]
    still_failing: list[RegressionItem]
    still_passing_count: int
    per_dataset: list[PerDatasetDelta]
    summary: dict


def _collect_run_group(session: Session, project_id: str, run_name: str):
    """Return {(question, dataset_id): {score, eval_id, category, severity, dataset_name}}."""
    runs = session.exec(
        select(DatasetRun)
        .where(DatasetRun.project_id == project_id)
        .where(DatasetRun.name == run_name)
    ).all()
    out: dict[tuple[str, str], dict] = {}
    if not runs:
        return out
    run_ids = [r.id for r in runs]
    dataset_ids = list({r.dataset_id for r in runs})
    datasets = session.exec(select(Dataset).where(Dataset.id.in_(dataset_ids))).all()
    dataset_by_id = {d.id: d for d in datasets}
    items = session.exec(
        select(DatasetRunItem).where(DatasetRunItem.dataset_run_id.in_(run_ids))
    ).all()
    row_ids = [it.dataset_row_id for it in items]
    rows = session.exec(select(DatasetRow).where(DatasetRow.id.in_(row_ids))).all() if row_ids else []
    row_by_id = {r.id: r for r in rows}
    eval_ids = [it.evaluation_id for it in items if it.evaluation_id]
    evals = session.exec(select(Evaluation).where(Evaluation.id.in_(eval_ids))).all() if eval_ids else []
    eval_by_id = {e.id: e for e in evals}
    findings = session.exec(
        select(GuidelineFinding).where(GuidelineFinding.evaluation_id.in_(eval_ids))
    ).all() if eval_ids else []
    sev_by_eval: dict[str, str] = {}
    sev_rank = {"critical": 3, "major": 2, "minor": 1}
    for f in findings:
        cur = sev_by_eval.get(f.evaluation_id or "")
        if not cur or sev_rank.get((f.severity or "").lower(), 0) > sev_rank.get(cur, 0):
            sev_by_eval[f.evaluation_id or ""] = (f.severity or "").lower()
    for it in items:
        if not it.evaluation_id:
            continue
        ev = eval_by_id.get(it.evaluation_id)
        row = row_by_id.get(it.dataset_row_id)
        if not ev or not row:
            continue
        ds = dataset_by_id.get(row.dataset_id)
        key = (row.question.strip(), row.dataset_id)
        out[key] = {
            "score": ev.combined_score,
            "eval_id": ev.id,
            "category": row.category,
            "severity": sev_by_eval.get(ev.id),
            "dataset_name": ds.name if ds else "",
            "is_passing": _is_passing(ev),
        }
    return out


def _compute_regression(
    session: Session,
    project_id: str,
    base_run_name: str,
    head_run_name: str,
) -> RegressionResponse:
    base = _collect_run_group(session, project_id, base_run_name)
    head = _collect_run_group(session, project_id, head_run_name)
    sev_rank = {"critical": 3, "major": 2, "minor": 1}

    newly_broken: list[RegressionItem] = []
    newly_fixed: list[RegressionItem] = []
    still_failing: list[RegressionItem] = []
    still_passing = 0
    per_ds: dict[str, dict] = {}
    common_keys = set(base.keys()) & set(head.keys())
    for key in common_keys:
        b, h = base[key], head[key]
        question, _ = key
        ds_name = h.get("dataset_name") or b.get("dataset_name") or ""
        pd = per_ds.setdefault(ds_name, {"b_pass": 0, "b_tot": 0, "h_pass": 0, "h_tot": 0})
        pd["b_tot"] += 1
        pd["h_tot"] += 1
        if b["is_passing"]:
            pd["b_pass"] += 1
        if h["is_passing"]:
            pd["h_pass"] += 1
        item = RegressionItem(
            question=question,
            dataset_name=ds_name,
            base_score=b["score"],
            head_score=h["score"],
            eval_id_base=b["eval_id"],
            eval_id_head=h["eval_id"],
            category=h.get("category") or b.get("category"),
            severity=h.get("severity") or b.get("severity"),
        )
        b_pass = b["is_passing"]
        h_pass = h["is_passing"]
        if b_pass and not h_pass:
            newly_broken.append(item)
        elif not b_pass and h_pass:
            newly_fixed.append(item)
        elif not b_pass and not h_pass:
            still_failing.append(item)
        else:
            still_passing += 1

    def _rank(it: RegressionItem) -> tuple[int, float]:
        sev = sev_rank.get((it.severity or "").lower(), 0)
        delta = abs((it.head_score or 0) - (it.base_score or 0))
        return (-sev, -delta)

    newly_broken.sort(key=_rank)
    newly_fixed.sort(key=_rank)
    still_failing.sort(key=_rank)

    per_dataset: list[PerDatasetDelta] = []
    for ds, v in per_ds.items():
        b_rate = (v["b_pass"] / v["b_tot"] * 100.0) if v["b_tot"] else 0.0
        h_rate = (v["h_pass"] / v["h_tot"] * 100.0) if v["h_tot"] else 0.0
        per_dataset.append(
            PerDatasetDelta(
                dataset_name=ds,
                base_pass_rate=round(b_rate, 2),
                head_pass_rate=round(h_rate, 2),
                delta_pp=round(h_rate - b_rate, 2),
            )
        )
    per_dataset.sort(key=lambda p: p.delta_pp)

    # Net pp delta across all common keys
    total = len(common_keys) or 1
    base_pass_total = sum(1 for k in common_keys if base[k]["is_passing"])
    head_pass_total = sum(1 for k in common_keys if head[k]["is_passing"])
    net_delta = round((head_pass_total - base_pass_total) / total * 100.0, 2)

    return RegressionResponse(
        base_run_name=base_run_name,
        head_run_name=head_run_name,
        newly_broken=newly_broken[:50],
        newly_fixed=newly_fixed[:50],
        still_failing=still_failing[:50],
        still_passing_count=still_passing,
        per_dataset=per_dataset,
        summary={
            "newly_broken_count": len(newly_broken),
            "newly_fixed_count": len(newly_fixed),
            "still_failing_count": len(still_failing),
            "still_passing_count": still_passing,
            "net_delta_pp": net_delta,
        },
    )


@router.get("/analytics/regression", response_model=RegressionResponse)
def analytics_regression(
    project_id: str = Query(...),
    base_run_name: str = Query(...),
    head_run_name: str = Query(...),
    session: Session = Depends(get_session),
) -> RegressionResponse:
    return _compute_regression(session, project_id, base_run_name, head_run_name)


class FailureCluster(BaseModel):
    category: str
    tag: str
    failure_count: int
    severity_score: int
    sample_questions: list[str]


class FailureClustersResponse(BaseModel):
    clusters: list[FailureCluster]
    run_name: str | None


def _compute_failure_clusters(
    session: Session,
    project_id: str,
    run_name: str | None = None,
    dataset_id: str | None = None,
) -> FailureClustersResponse:
    # Resolve run-name: if not provided use the latest run-group name
    runs_q = select(DatasetRun).where(DatasetRun.project_id == project_id)
    if run_name:
        runs_q = runs_q.where(DatasetRun.name == run_name)
    else:
        latest_q = select(DatasetRun).where(DatasetRun.project_id == project_id)
        if dataset_id:
            latest_q = latest_q.where(DatasetRun.dataset_id == dataset_id)
        latest = session.exec(
            latest_q.order_by(DatasetRun.started_at.desc())
        ).first()
        if latest is None:
            return FailureClustersResponse(clusters=[], run_name=None)
        run_name = latest.name
        runs_q = runs_q.where(DatasetRun.name == run_name)
    if dataset_id:
        runs_q = runs_q.where(DatasetRun.dataset_id == dataset_id)
    runs = session.exec(runs_q).all()
    if not runs:
        return FailureClustersResponse(clusters=[], run_name=run_name)
    run_ids = [r.id for r in runs]
    items = session.exec(
        select(DatasetRunItem).where(DatasetRunItem.dataset_run_id.in_(run_ids))
    ).all()
    row_ids = [it.dataset_row_id for it in items]
    rows = session.exec(select(DatasetRow).where(DatasetRow.id.in_(row_ids))).all() if row_ids else []
    row_by_id = {r.id: r for r in rows}
    eval_ids = [it.evaluation_id for it in items if it.evaluation_id]
    evals = session.exec(select(Evaluation).where(Evaluation.id.in_(eval_ids))).all() if eval_ids else []
    eval_by_id = {e.id: e for e in evals}
    findings = session.exec(
        select(GuidelineFinding).where(GuidelineFinding.evaluation_id.in_(eval_ids))
    ).all() if eval_ids else []
    worst_sev: dict[str, str] = {}
    sev_rank = {"critical": 3, "major": 2, "minor": 1}
    for f in findings:
        eid = f.evaluation_id or ""
        cur = worst_sev.get(eid)
        if not cur or sev_rank.get((f.severity or "").lower(), 0) > sev_rank.get(cur, 0):
            worst_sev[eid] = (f.severity or "").lower()

    clusters: dict[tuple[str, str], dict] = {}
    for it in items:
        if not it.evaluation_id:
            continue
        ev = eval_by_id.get(it.evaluation_id)
        row = row_by_id.get(it.dataset_row_id)
        if not ev or not row:
            continue
        # Skip rows that pass under the override-aware rule.
        if _is_passing(ev):
            continue
        if ev.combined_score is None and not (ev.override_verdict or "").strip():
            continue
        cat = row.category or "Uncategorized"
        try:
            tags = json.loads(row.tags_json or "[]")
        except (json.JSONDecodeError, TypeError):
            tags = []
        if not tags:
            tags = ["(no-tag)"]
        sev = worst_sev.get(ev.id) or "no-finding"
        sev_weight = sev_rank.get(sev, 1)
        for tag in tags:
            key = (cat, str(tag))
            entry = clusters.setdefault(
                key, {"failure_count": 0, "severity_score": 0, "samples": []}
            )
            entry["failure_count"] += 1
            entry["severity_score"] += sev_weight
            if len(entry["samples"]) < 3:
                entry["samples"].append(row.question)
    out = [
        FailureCluster(
            category=k[0],
            tag=k[1],
            failure_count=v["failure_count"],
            severity_score=v["severity_score"],
            sample_questions=v["samples"],
        )
        for k, v in clusters.items()
    ]
    out.sort(key=lambda c: (-c.severity_score, -c.failure_count))
    return FailureClustersResponse(clusters=out[:20], run_name=run_name)


@router.get("/analytics/failure-clusters", response_model=FailureClustersResponse)
def analytics_failure_clusters(
    project_id: str = Query(...),
    run_name: str | None = Query(default=None),
    dataset_id: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> FailureClustersResponse:
    return _compute_failure_clusters(session, project_id, run_name=run_name, dataset_id=dataset_id)


class SeverityTrendPoint(BaseModel):
    run_name: str
    started_at: datetime
    critical: int
    major: int
    minor: int


class SeverityTrendResponse(BaseModel):
    series: list[SeverityTrendPoint]


def _compute_severity_trend(
    session: Session,
    project_id: str,
    dataset_id: str | None = None,
) -> SeverityTrendResponse:
    runs_q = select(DatasetRun).where(DatasetRun.project_id == project_id)
    if dataset_id:
        runs_q = runs_q.where(DatasetRun.dataset_id == dataset_id)
    runs = session.exec(runs_q.order_by(DatasetRun.started_at.asc())).all()
    # Group by name; pick earliest started_at per name
    groups: dict[str, list[DatasetRun]] = {}
    for r in runs:
        groups.setdefault(r.name or "(unnamed)", []).append(r)
    series: list[SeverityTrendPoint] = []
    for name, grp in groups.items():
        run_ids = [r.id for r in grp]
        items = session.exec(
            select(DatasetRunItem).where(DatasetRunItem.dataset_run_id.in_(run_ids))
        ).all()
        eval_ids = [it.evaluation_id for it in items if it.evaluation_id]
        if not eval_ids:
            continue
        findings = session.exec(
            select(GuidelineFinding).where(GuidelineFinding.evaluation_id.in_(eval_ids))
        ).all()
        counts = {"critical": 0, "major": 0, "minor": 0}
        for f in findings:
            sev = (f.severity or "").lower()
            if sev in counts:
                counts[sev] += 1
        started = min(r.started_at for r in grp)
        series.append(
            SeverityTrendPoint(
                run_name=name,
                started_at=started,
                critical=counts["critical"],
                major=counts["major"],
                minor=counts["minor"],
            )
        )
    series.sort(key=lambda p: p.started_at)
    return SeverityTrendResponse(series=series)


@router.get("/analytics/severity-trend", response_model=SeverityTrendResponse)
def analytics_severity_trend(
    project_id: str = Query(...),
    dataset_id: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> SeverityTrendResponse:
    return _compute_severity_trend(session, project_id, dataset_id=dataset_id)


class TopTokenEvaluation(BaseModel):
    id: str
    question: str
    judge_total_tokens: int
    reference_total_tokens: int
    chatbot_total_tokens: int
    total_tokens: int
    created_at: datetime


def _compute_top_token_evaluations(
    session: Session,
    project_id: str,
    limit: int = 10,
    dataset_id: str | None = None,
    run_name: str | None = None,
) -> list[TopTokenEvaluation]:
    rows = session.exec(
        select(Evaluation).where(Evaluation.project_id == project_id)
    ).all()
    # Optionally narrow to evals participating in a specific run-name or dataset.
    if dataset_id or run_name:
        runs_q = select(DatasetRun).where(DatasetRun.project_id == project_id)
        if dataset_id:
            runs_q = runs_q.where(DatasetRun.dataset_id == dataset_id)
        if run_name:
            runs_q = runs_q.where(DatasetRun.name == run_name)
        runs = session.exec(runs_q).all()
        run_ids = [r.id for r in runs]
        items = (
            session.exec(
                select(DatasetRunItem).where(DatasetRunItem.dataset_run_id.in_(run_ids))
            ).all()
            if run_ids else []
        )
        allowed = {it.evaluation_id for it in items if it.evaluation_id}
        rows = [e for e in rows if e.id in allowed]
    out: list[TopTokenEvaluation] = []
    for ev in rows:
        j = int(ev.judge_total_tokens or 0)
        rf = int(ev.reference_total_tokens or 0)
        cb = int(ev.chatbot_total_tokens or 0)
        total = j + rf + cb
        if total <= 0:
            continue
        out.append(
            TopTokenEvaluation(
                id=ev.id,
                question=(ev.question or "")[:200],
                judge_total_tokens=j,
                reference_total_tokens=rf,
                chatbot_total_tokens=cb,
                total_tokens=total,
                created_at=ev.created_at,
            )
        )
    out.sort(key=lambda e: -e.total_tokens)
    return out[:limit]


@router.get("/analytics/top-token-evaluations", response_model=list[TopTokenEvaluation])
def analytics_top_token_evaluations(
    project_id: str = Query(...),
    limit: int = Query(default=10, ge=1, le=100),
    dataset_id: str | None = Query(default=None),
    run_name: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> list[TopTokenEvaluation]:
    """Top-N evaluations ordered by total tokens (judge+reference+chatbot)."""
    return _compute_top_token_evaluations(
        session, project_id, limit=limit, dataset_id=dataset_id, run_name=run_name,
    )


def _compute_tokens_by_run(
    session: Session,
    project_id: str,
    dataset_id: str | None = None,
) -> list[TokensByRunPoint]:
    """Aggregated token counts per run-group (name), broken into judge / reference / chatbot."""
    runs_q = select(DatasetRun).where(DatasetRun.project_id == project_id)
    if dataset_id:
        runs_q = runs_q.where(DatasetRun.dataset_id == dataset_id)
    runs = session.exec(runs_q.order_by(DatasetRun.started_at.asc())).all()
    if not runs:
        return []
    groups: dict[str, list[DatasetRun]] = {}
    for r in runs:
        groups.setdefault(r.name or "(unnamed)", []).append(r)
    out: list[TokensByRunPoint] = []
    for name, grp in groups.items():
        run_ids = [r.id for r in grp]
        items = session.exec(
            select(DatasetRunItem).where(DatasetRunItem.dataset_run_id.in_(run_ids))
        ).all()
        eval_ids = [it.evaluation_id for it in items if it.evaluation_id]
        if not eval_ids:
            continue
        evs = session.exec(
            select(Evaluation).where(Evaluation.id.in_(eval_ids))
        ).all()
        j = sum(int(e.judge_total_tokens or 0) for e in evs)
        rf = sum(int(e.reference_total_tokens or 0) for e in evs)
        cb = sum(int(e.chatbot_total_tokens or 0) for e in evs)
        started = min(r.started_at for r in grp)
        out.append(
            TokensByRunPoint(
                run_name=name,
                started_at=started,
                judge=j,
                reference=rf,
                chatbot=cb,
                total=j + rf + cb,
            )
        )
    out.sort(key=lambda p: p.started_at)
    return out


class RunNameItem(BaseModel):
    name: str
    started_at: datetime
    run_count: int


@router.get("/analytics/run-names", response_model=list[RunNameItem])
def analytics_run_names(
    project_id: str = Query(...),
    session: Session = Depends(get_session),
) -> list[RunNameItem]:
    runs = session.exec(
        select(DatasetRun)
        .where(DatasetRun.project_id == project_id)
        .order_by(DatasetRun.started_at.asc())
    ).all()
    groups: dict[str, list[DatasetRun]] = {}
    for r in runs:
        if not r.name:
            continue
        groups.setdefault(r.name, []).append(r)
    out = [
        RunNameItem(
            name=name,
            started_at=min(r.started_at for r in grp),
            run_count=len(grp),
        )
        for name, grp in groups.items()
    ]
    out.sort(key=lambda x: x.started_at)
    return out
