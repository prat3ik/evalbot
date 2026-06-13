from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

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
    Question,
    ReferenceAnswer,
)
from ..services.reference import question_hash
from ..engines.pii import filter_allowed, scan_pii
from .evaluate import (
    DimensionBreakdown,
    EvaluateResponse,
    GuidelineFindingOut,
    MetricScoreOut,
    PIIHitOut,
)

router = APIRouter()


class EvaluationListItem(BaseModel):
    id: str
    project_id: str
    project_name: str | None = None
    question: str
    method: str
    ai_provider: str | None = None
    ml_score: float | None = None
    ai_score: float | None = None
    combined_score: float | None = None
    run_type: str = "single"
    # Aggregated token totals for the activity row (judge + reference + chatbot).
    judge_total_tokens: int | None = None
    reference_total_tokens: int | None = None
    chatbot_total_tokens: int | None = None
    total_tokens: int | None = None
    created_at: datetime
    # Optional analytics-side fields. Category is resolved from the source
    # DatasetRow (if this eval was kicked off via a dataset) or from a Question
    # row matching the question text. Dimensions aggregate MetricScore rows for
    # the five standard AI-judge metrics so the client can render its
    # category × dimension matrix without a second round-trip.
    category: str | None = None
    dimensions: dict[str, float] = {}
    override_verdict: str | None = None
    override_note: str | None = None
    override_author: str | None = None
    override_created_at: str | None = None


@router.get("/evaluations", response_model=list[EvaluationListItem])
def list_evaluations(
    project_id: str | None = Query(default=None),
    method: str | None = Query(default=None),
    category: str | None = Query(default=None),
    since: datetime | None = Query(default=None),
    start_date: datetime | None = Query(default=None),
    end_date: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
) -> list[EvaluationListItem]:
    stmt = select(Evaluation)
    if project_id:
        stmt = stmt.where(Evaluation.project_id == project_id)
    if method:
        stmt = stmt.where(Evaluation.method == method)
    effective_since = since or start_date
    if effective_since:
        stmt = stmt.where(Evaluation.created_at >= effective_since)
    if end_date:
        stmt = stmt.where(Evaluation.created_at <= end_date)
    stmt = stmt.order_by(Evaluation.created_at.desc()).offset(offset).limit(limit)
    rows = session.exec(stmt).all()

    # Resolve project names
    project_ids = {r.project_id for r in rows}
    name_by_id: dict[str, str] = {}
    if project_ids:
        for p in session.exec(select(Project).where(Project.id.in_(list(project_ids)))).all():
            name_by_id[p.id] = p.name

    # Compute run_type per row. Prefer the column value when explicitly set to
    # something non-default; otherwise infer:
    #   - linked via DatasetRunItem.evaluation_id -> "dataset"
    #   - linked via MetricScore.turn_evaluation_id chain -> "multi_turn"
    #   - else fall back to stored value (default "single").
    eval_ids = [r.id for r in rows]
    dataset_eval_ids: set[str] = set()
    multi_turn_eval_ids: set[str] = set()
    # eval_id -> source DatasetRow.id (so we can pull category from the row).
    row_id_by_eval: dict[str, str] = {}
    ms_rows: list[MetricScore] = []
    if eval_ids:
        run_items = session.exec(
            select(DatasetRunItem).where(DatasetRunItem.evaluation_id.in_(eval_ids))
        ).all()
        for it in run_items:
            if it.evaluation_id:
                dataset_eval_ids.add(it.evaluation_id)
                row_id_by_eval[it.evaluation_id] = it.dataset_row_id
        # An Evaluation participating in multi-turn would share MetricScore rows
        # tagged with a turn_evaluation_id pointing at a TurnEvaluation.
        ms_rows = session.exec(
            select(MetricScore).where(MetricScore.evaluation_id.in_(eval_ids))
        ).all()
        turn_ids = {m.turn_evaluation_id for m in ms_rows if m.turn_evaluation_id}
        if turn_ids:
            turn_owner_by_eval: dict[str, str] = {}
            for m in ms_rows:
                if m.evaluation_id and m.turn_evaluation_id:
                    turn_owner_by_eval[m.evaluation_id] = m.turn_evaluation_id
            multi_turn_eval_ids = set(turn_owner_by_eval.keys())

    # Resolve categories. Priority: source DatasetRow.category, then a Question
    # matching by exact text (seeded questions carry a category).
    cat_by_row_id: dict[str, str | None] = {}
    row_ids = list({rid for rid in row_id_by_eval.values()})
    if row_ids:
        for dr in session.exec(
            select(DatasetRow).where(DatasetRow.id.in_(row_ids))
        ).all():
            cat_by_row_id[dr.id] = dr.category
    question_texts = list({r.question for r in rows})
    cat_by_question: dict[str, str] = {}
    if question_texts:
        for q in session.exec(
            select(Question).where(Question.text.in_(question_texts))
        ).all():
            # Last write wins; that's fine — categories are stable per text.
            cat_by_question[q.text] = q.category

    # Aggregate AI-judge dimension MetricScores into per-evaluation averages
    # (a single eval may have one row per dimension when method="both").
    _DIM_NAMES = {"similarity", "accuracy", "completeness", "relevance", "readability"}
    dim_sum: dict[str, dict[str, list[float]]] = {}
    for m in ms_rows:
        if not m.evaluation_id or m.metric_name not in _DIM_NAMES:
            continue
        # Prefer AI-engine values; fall back to ML if AI is absent.
        bucket = dim_sum.setdefault(m.evaluation_id, {})
        bucket.setdefault(m.metric_name, []).append(float(m.value))
    dims_by_eval: dict[str, dict[str, float]] = {}
    for eid, dims in dim_sum.items():
        dims_by_eval[eid] = {
            name: sum(vals) / len(vals) for name, vals in dims.items() if vals
        }

    def _category_for(r: Evaluation) -> str | None:
        rid = row_id_by_eval.get(r.id)
        if rid and cat_by_row_id.get(rid):
            return cat_by_row_id[rid]
        return cat_by_question.get(r.question)

    def _classify(r: Evaluation) -> str:
        stored = (r.run_type or "single").strip() or "single"
        if stored != "single":
            return stored
        if r.id in dataset_eval_ids:
            return "dataset"
        if r.id in multi_turn_eval_ids:
            return "multi_turn"
        return stored

    return [
        EvaluationListItem(
            id=r.id,
            project_id=r.project_id,
            project_name=name_by_id.get(r.project_id),
            question=r.question,
            method=r.method,
            ai_provider=r.ai_provider,
            ml_score=r.ml_score,
            ai_score=r.ai_score,
            combined_score=r.combined_score,
            run_type=_classify(r),
            judge_total_tokens=r.judge_total_tokens,
            reference_total_tokens=r.reference_total_tokens,
            chatbot_total_tokens=r.chatbot_total_tokens,
            total_tokens=(
                (r.judge_total_tokens or 0)
                + (r.reference_total_tokens or 0)
                + (r.chatbot_total_tokens or 0)
            )
            or None,
            created_at=r.created_at,
            category=_category_for(r),
            dimensions=dims_by_eval.get(r.id, {}),
            override_verdict=r.override_verdict,
            override_note=r.override_note,
            override_author=r.override_author,
            override_created_at=r.override_created_at,
        )
        for r in rows
    ]


@router.get("/evaluations/{evaluation_id}", response_model=EvaluateResponse)
def get_evaluation(
    evaluation_id: str,
    session: Session = Depends(get_session),
) -> EvaluateResponse:
    ev = session.get(Evaluation, evaluation_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="Evaluation not found")

    metrics = session.exec(
        select(MetricScore).where(MetricScore.evaluation_id == evaluation_id)
    ).all()
    findings = session.exec(
        select(GuidelineFinding).where(GuidelineFinding.evaluation_id == evaluation_id)
    ).all()

    # Re-build dimension breakdowns from stored MetricScore rows.
    dim_names = {"similarity", "accuracy", "completeness", "relevance", "readability"}

    def _dims_for(engine: str) -> DimensionBreakdown | None:
        present = {
            m.metric_name: m.value
            for m in metrics
            if m.engine == engine and m.metric_name in dim_names
        }
        if not present:
            return None
        return DimensionBreakdown(
            similarity=present.get("similarity", 0.0),
            accuracy=present.get("accuracy", 0.0),
            completeness=present.get("completeness", 0.0),
            relevance=present.get("relevance", 0.0),
            readability=present.get("readability", 0.0),
        )

    ml_dims = _dims_for("ml")
    ai_dims = _dims_for("ai")

    # Retrieved chunks: pull from cached ReferenceAnswer if available.
    retrieved_chunks: list[dict] = []
    ra = session.exec(
        select(ReferenceAnswer)
        .where(ReferenceAnswer.project_id == ev.project_id)
        .where(ReferenceAnswer.question_hash == question_hash(ev.project_id, ev.question))
    ).first()
    if ra is not None:
        try:
            retrieved_chunks = json.loads(ra.retrieved_chunks_json or "[]")
        except json.JSONDecodeError:
            retrieved_chunks = []

    # Back-reference: if this evaluation came from a dataset run, the
    # DatasetRunItem table links the two. We surface enough to render a
    # link on the detail page without forcing the client to make another
    # round-trip.
    dataset_run_id: str | None = None
    dataset_run_name: str | None = None
    dataset_id: str | None = None
    dataset_name: str | None = None
    dataset_row_id: str | None = None
    turns: list[dict] = []
    run_item = session.exec(
        select(DatasetRunItem).where(DatasetRunItem.evaluation_id == evaluation_id)
    ).first()
    if run_item is not None:
        run = session.get(DatasetRun, run_item.dataset_run_id)
        if run is not None:
            dataset_run_id = run.id
            dataset_run_name = run.name
            dataset_id = run.dataset_id
            ds = session.get(Dataset, run.dataset_id)
            if ds is not None:
                dataset_name = ds.name
        dataset_row_id = run_item.dataset_row_id
        # Pull the source row's multi-turn transcript (if any) so the detail
        # page can render the full conversation context instead of just the
        # last user turn stored on Evaluation.question.
        if dataset_row_id:
            src_row = session.get(DatasetRow, dataset_row_id)
            if src_row is not None and src_row.turns_json:
                try:
                    parsed = json.loads(src_row.turns_json)
                    if isinstance(parsed, list):
                        turns = [
                            {"role": str(t.get("role", "")), "content": str(t.get("content", ""))}
                            for t in parsed
                            if isinstance(t, dict)
                        ]
                except json.JSONDecodeError:
                    turns = []

    return EvaluateResponse(
        id=ev.id,
        project_id=ev.project_id,
        question=ev.question,
        chatbot_response=ev.chatbot_response,
        reference_answer=ev.reference_answer,
        method=ev.method,  # type: ignore[arg-type]
        ai_provider=ev.ai_provider,
        ml_score=ev.ml_score,
        ai_score=ev.ai_score,
        combined_score=ev.combined_score,
        judge_prompt_tokens=ev.judge_prompt_tokens,
        judge_completion_tokens=ev.judge_completion_tokens,
        judge_total_tokens=ev.judge_total_tokens,
        reference_prompt_tokens=ev.reference_prompt_tokens,
        reference_completion_tokens=ev.reference_completion_tokens,
        reference_total_tokens=ev.reference_total_tokens,
        chatbot_prompt_tokens=ev.chatbot_prompt_tokens,
        chatbot_completion_tokens=ev.chatbot_completion_tokens,
        chatbot_total_tokens=ev.chatbot_total_tokens,
        ml_dimensions=ml_dims,
        ai_dimensions=ai_dims,
        ml_metrics=[
            MetricScoreOut(engine="ml", metric_name=m.metric_name, value=m.value, weight=m.weight)
            for m in metrics
            if m.engine == "ml"
        ],
        ai_metrics=[
            MetricScoreOut(engine="ai", metric_name=m.metric_name, value=m.value, weight=m.weight)
            for m in metrics
            if m.engine == "ai"
        ],
        guideline_findings=[
            GuidelineFindingOut(
                guideline_excerpt=f.guideline_excerpt,
                offending_span=f.offending_span,
                reason=f.reason,
                severity=f.severity,
            )
            for f in findings
        ],
        retrieved_chunks=retrieved_chunks,
        rationale=ev.rationale,
        created_at=ev.created_at,
        pii_hits=[
            PIIHitOut(kind=h.kind, span=h.span, start=h.start, end=h.end)
            for h in filter_allowed(
                scan_pii(ev.chatbot_response or ""),
                (session.get(Project, ev.project_id).allowed_pii_patterns or "")
                if session.get(Project, ev.project_id) is not None else "",
            )
        ],
        dataset_run_id=dataset_run_id,
        dataset_run_name=dataset_run_name,
        dataset_id=dataset_id,
        dataset_name=dataset_name,
        dataset_row_id=dataset_row_id,
        turns=turns,
        override_verdict=ev.override_verdict,
        override_note=ev.override_note,
        override_author=ev.override_author,
        override_created_at=ev.override_created_at,
    )


class OverrideRequest(BaseModel):
    verdict: str | None = None  # "pass" | "fail" | None (clears)
    note: str = ""


@router.patch("/evaluations/{evaluation_id}/override", response_model=EvaluateResponse)
def patch_evaluation_override(
    evaluation_id: str,
    body: OverrideRequest,
    session: Session = Depends(get_session),
) -> EvaluateResponse:
    ev = session.get(Evaluation, evaluation_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="Evaluation not found")

    verdict = body.verdict
    if verdict is not None:
        v = str(verdict).strip().lower()
        if v not in ("pass", "fail"):
            raise HTTPException(status_code=400, detail="verdict must be 'pass', 'fail', or null")
        if len((body.note or "").strip()) < 10:
            raise HTTPException(status_code=400, detail="note must be at least 10 characters")
        ev.override_verdict = v
        ev.override_note = body.note.strip()
        ev.override_author = "demo-user"
        ev.override_created_at = datetime.utcnow().isoformat()
    else:
        # Clear override.
        ev.override_verdict = None
        ev.override_note = None
        ev.override_author = None
        ev.override_created_at = None

    session.add(ev)
    session.commit()
    session.refresh(ev)
    return get_evaluation(evaluation_id, session)
