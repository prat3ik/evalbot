from __future__ import annotations

import asyncio
import csv
import io
import json
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, select

from ..chatbot_client import call_chatbot
from ..db import engine as db_engine, get_session
from ..models import (
    ChatbotEndpoint,
    Dataset,
    DatasetRow,
    DatasetRun,
    DatasetRunItem,
    DatasetSchedule,
    Evaluation,
    MetricScore,
    Project,
)
from .evaluate import run_evaluation_core

router = APIRouter()

EvaluationMethod = Literal["ml", "ai", "both"]

# Hold strong references to fire-and-forget background tasks so they aren't
# garbage-collected mid-flight (per asyncio.create_task docs).
_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class DatasetCreate(BaseModel):
    name: str
    description: str | None = None


class DatasetUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class ChatTurn(BaseModel):
    role: str  # "user" | "assistant"
    content: str = ""


class DatasetRowIn(BaseModel):
    question: str
    expected_response: str | None = None
    chatbot_response: str | None = None
    tags: list[str] = []
    category: str | None = None
    # "manual" | "endpoint:<id>" | None (= defer to run default)
    chatbot_source: str | None = None
    # Optional multi-turn transcript. When non-empty, `question` is treated as
    # the last user turn (the bot's next reply is what gets graded).
    turns: list[ChatTurn] = []


class DatasetRowBulk(BaseModel):
    rows: list[DatasetRowIn]


class DatasetRowOut(BaseModel):
    id: str
    dataset_id: str
    position: int
    question: str
    expected_response: str | None
    chatbot_response: str | None
    tags: list[str]
    category: str | None
    chatbot_source: str | None = None
    turns: list[ChatTurn] = []


class DatasetLastRunSummary(BaseModel):
    id: str
    name: str | None = None
    status: str
    started_at: datetime
    finished_at: datetime | None
    completed_rows: int
    total_rows: int
    pass_rate: float | None = None
    avg_combined: float | None = None


class DatasetOut(BaseModel):
    id: str
    project_id: str
    name: str
    description: str | None
    created_at: datetime
    row_count: int = 0
    last_run: DatasetLastRunSummary | None = None


class DatasetDetail(DatasetOut):
    rows: list[DatasetRowOut] = []


class DatasetRunRequest(BaseModel):
    method: EvaluationMethod = "both"
    ai_provider: str | None = None
    tag_filter: list[str] = []
    chatbot_endpoint_id: str | None = None
    name: str | None = None


class DatasetRunItemOut(BaseModel):
    id: str
    dataset_row_id: str
    evaluation_id: str | None
    error: str | None
    question: str | None = None
    tags: list[str] = []
    category: str | None = None
    combined_score: float | None = None
    ml_score: float | None = None
    ai_score: float | None = None
    judge_total_tokens: int | None = None
    reference_total_tokens: int | None = None
    chatbot_total_tokens: int | None = None
    total_tokens: int | None = None


class TagSummary(BaseModel):
    tag: str
    count: int
    avg_combined: float | None
    pass_rate: float | None


class CategorySummary(BaseModel):
    category: str
    count: int
    avg_combined: float | None
    pass_rate: float | None


class DatasetRunSummary(BaseModel):
    avg_combined: float | None
    pass_rate: float | None
    total_rows: int
    by_tag: list[TagSummary] = []
    by_category: list[CategorySummary] = []
    total_judge_tokens: int = 0
    total_reference_tokens: int = 0
    total_chatbot_tokens: int = 0
    total_tokens: int = 0


class DatasetRunOut(BaseModel):
    id: str
    dataset_id: str
    project_id: str
    name: str | None = None
    method: str
    ai_provider: str | None
    status: str
    started_at: datetime
    finished_at: datetime | None
    total_rows: int
    completed_rows: int
    error: str | None
    chatbot_endpoint_id: str | None = None
    chatbot_endpoint_name: str | None = None
    chatbot_endpoint_url: str | None = None
    items: list[DatasetRunItemOut] = []
    summary: DatasetRunSummary | None = None


class DatasetScheduleIn(BaseModel):
    cron: str | None = None
    enabled: bool = False


class DatasetScheduleOut(BaseModel):
    dataset_id: str
    cron: str | None
    enabled: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_tags(s: str) -> list[str]:
    try:
        v = json.loads(s or "[]")
        if isinstance(v, list):
            return [str(x).strip().lower() for x in v if str(x).strip()]
    except Exception:
        pass
    return []


def _parse_turns(s: str | None) -> list[ChatTurn]:
    if not s:
        return []
    try:
        v = json.loads(s)
    except Exception:
        return []
    out: list[ChatTurn] = []
    if isinstance(v, list):
        for item in v:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "").strip().lower()
            if role not in ("user", "assistant"):
                continue
            out.append(ChatTurn(role=role, content=str(item.get("content") or "")))
    return out


def _serialize_turns(turns: list[ChatTurn]) -> str:
    return json.dumps([{"role": t.role, "content": t.content} for t in turns])


def _row_to_out(r: DatasetRow) -> DatasetRowOut:
    return DatasetRowOut(
        id=r.id,
        dataset_id=r.dataset_id,
        position=r.position,
        question=r.question,
        expected_response=r.expected_response,
        chatbot_response=r.chatbot_response,
        tags=_parse_tags(r.tags_json),
        category=r.category,
        chatbot_source=r.chatbot_source,
        turns=_parse_turns(r.turns_json),
    )


def _last_run_summary(session: Session, dataset_id: str) -> DatasetLastRunSummary | None:
    row = session.exec(
        select(DatasetRun)
        .where(DatasetRun.dataset_id == dataset_id)
        .order_by(DatasetRun.started_at.desc())
    ).first()
    if row is None:
        return None
    items = session.exec(
        select(DatasetRunItem).where(DatasetRunItem.dataset_run_id == row.id)
    ).all()
    scores: list[float] = []
    for it in items:
        if it.evaluation_id:
            ev = session.get(Evaluation, it.evaluation_id)
            if ev and ev.combined_score is not None:
                scores.append(float(ev.combined_score))
    avg = sum(scores) / len(scores) if scores else None
    pass_rate = sum(1 for s in scores if s >= 75) / len(scores) if scores else None
    return DatasetLastRunSummary(
        id=row.id,
        name=row.name,
        status=row.status,
        started_at=row.started_at,
        finished_at=row.finished_at,
        completed_rows=row.completed_rows,
        total_rows=row.total_rows,
        avg_combined=avg,
        pass_rate=pass_rate,
    )


def _dataset_to_out(session: Session, d: Dataset) -> DatasetOut:
    count = len(session.exec(select(DatasetRow).where(DatasetRow.dataset_id == d.id)).all())
    return DatasetOut(
        id=d.id,
        project_id=d.project_id,
        name=d.name,
        description=d.description,
        created_at=d.created_at,
        row_count=count,
        last_run=_last_run_summary(session, d.id),
    )


def _next_position(session: Session, dataset_id: str) -> int:
    rows = session.exec(select(DatasetRow).where(DatasetRow.dataset_id == dataset_id)).all()
    return max((r.position for r in rows), default=-1) + 1


# ---------------------------------------------------------------------------
# Dataset CRUD
# ---------------------------------------------------------------------------


@router.post("/projects/{project_id}/datasets", response_model=DatasetOut, status_code=201)
def create_dataset(
    project_id: str,
    payload: DatasetCreate,
    session: Session = Depends(get_session),
) -> DatasetOut:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    d = Dataset(project_id=project_id, name=name, description=payload.description)
    session.add(d)
    session.commit()
    session.refresh(d)
    return _dataset_to_out(session, d)


@router.get("/projects/{project_id}/datasets", response_model=list[DatasetOut])
def list_datasets(
    project_id: str,
    session: Session = Depends(get_session),
) -> list[DatasetOut]:
    rows = session.exec(
        select(Dataset).where(Dataset.project_id == project_id).order_by(Dataset.created_at.desc())
    ).all()
    return [_dataset_to_out(session, d) for d in rows]


@router.get("/datasets/{dataset_id}", response_model=DatasetDetail)
def get_dataset(
    dataset_id: str,
    session: Session = Depends(get_session),
) -> DatasetDetail:
    d = session.get(Dataset, dataset_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    rows = session.exec(
        select(DatasetRow)
        .where(DatasetRow.dataset_id == dataset_id)
        .order_by(DatasetRow.position.asc())
    ).all()
    base = _dataset_to_out(session, d)
    return DatasetDetail(
        **base.model_dump(),
        rows=[_row_to_out(r) for r in rows],
    )


@router.patch("/datasets/{dataset_id}", response_model=DatasetOut)
def update_dataset(
    dataset_id: str,
    payload: DatasetUpdate,
    session: Session = Depends(get_session),
) -> DatasetOut:
    d = session.get(Dataset, dataset_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if payload.name is not None:
        n = payload.name.strip()
        if not n:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        d.name = n
    if payload.description is not None:
        d.description = payload.description
    session.add(d)
    session.commit()
    session.refresh(d)
    return _dataset_to_out(session, d)


@router.delete("/datasets/{dataset_id}", status_code=204)
def delete_dataset(
    dataset_id: str,
    session: Session = Depends(get_session),
) -> None:
    d = session.get(Dataset, dataset_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    runs = session.exec(select(DatasetRun).where(DatasetRun.dataset_id == dataset_id)).all()
    run_ids = [r.id for r in runs]
    if run_ids:
        for item in session.exec(
            select(DatasetRunItem).where(DatasetRunItem.dataset_run_id.in_(run_ids))
        ).all():
            session.delete(item)
    for r in runs:
        session.delete(r)
    for row in session.exec(select(DatasetRow).where(DatasetRow.dataset_id == dataset_id)).all():
        session.delete(row)
    for sch in session.exec(
        select(DatasetSchedule).where(DatasetSchedule.dataset_id == dataset_id)
    ).all():
        session.delete(sch)
    session.delete(d)
    session.commit()


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------


def _normalize_tags(tags: list[str]) -> list[str]:
    out: list[str] = []
    for t in tags or []:
        s = str(t).strip().lower()
        if s and s not in out:
            out.append(s)
    return out


@router.post("/datasets/{dataset_id}/rows", response_model=DatasetRowOut, status_code=201)
def add_row(
    dataset_id: str,
    payload: DatasetRowIn,
    session: Session = Depends(get_session),
) -> DatasetRowOut:
    d = session.get(Dataset, dataset_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    q = payload.question.strip()
    if not q:
        raise HTTPException(status_code=400, detail="question required")
    row = DatasetRow(
        dataset_id=dataset_id,
        position=_next_position(session, dataset_id),
        question=q,
        expected_response=payload.expected_response,
        chatbot_response=payload.chatbot_response,
        tags_json=json.dumps(_normalize_tags(payload.tags)),
        category=payload.category,
        chatbot_source=payload.chatbot_source,
        turns_json=_serialize_turns(payload.turns),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _row_to_out(row)


@router.post("/datasets/{dataset_id}/rows/bulk", response_model=list[DatasetRowOut])
def bulk_add_rows(
    dataset_id: str,
    payload: DatasetRowBulk,
    session: Session = Depends(get_session),
) -> list[DatasetRowOut]:
    d = session.get(Dataset, dataset_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    pos = _next_position(session, dataset_id)
    out: list[DatasetRow] = []
    for r in payload.rows:
        q = r.question.strip()
        if not q:
            continue
        row = DatasetRow(
            dataset_id=dataset_id,
            position=pos,
            question=q,
            expected_response=r.expected_response,
            chatbot_response=r.chatbot_response,
            tags_json=json.dumps(_normalize_tags(r.tags)),
            category=r.category,
            chatbot_source=r.chatbot_source,
            turns_json=_serialize_turns(r.turns),
        )
        session.add(row)
        out.append(row)
        pos += 1
    session.commit()
    for r in out:
        session.refresh(r)
    return [_row_to_out(r) for r in out]


@router.put("/datasets/{dataset_id}/rows/{row_id}", response_model=DatasetRowOut)
def update_row(
    dataset_id: str,
    row_id: str,
    payload: DatasetRowIn,
    session: Session = Depends(get_session),
) -> DatasetRowOut:
    row = session.get(DatasetRow, row_id)
    if row is None or row.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Row not found")
    q = payload.question.strip()
    if not q:
        raise HTTPException(status_code=400, detail="question required")
    row.question = q
    row.expected_response = payload.expected_response
    row.chatbot_response = payload.chatbot_response
    row.tags_json = json.dumps(_normalize_tags(payload.tags))
    row.category = payload.category
    row.chatbot_source = payload.chatbot_source
    row.turns_json = _serialize_turns(payload.turns)
    session.add(row)
    session.commit()
    session.refresh(row)
    return _row_to_out(row)


@router.delete("/datasets/{dataset_id}/rows/{row_id}", status_code=204)
def delete_row(
    dataset_id: str,
    row_id: str,
    session: Session = Depends(get_session),
) -> None:
    row = session.get(DatasetRow, row_id)
    if row is None or row.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Row not found")
    session.delete(row)
    session.commit()
    # Compact positions
    remaining = session.exec(
        select(DatasetRow)
        .where(DatasetRow.dataset_id == dataset_id)
        .order_by(DatasetRow.position.asc())
    ).all()
    for i, r in enumerate(remaining):
        if r.position != i:
            r.position = i
            session.add(r)
    session.commit()


# ---------------------------------------------------------------------------
# Import (CSV or JSON)
# ---------------------------------------------------------------------------


def _parse_csv_tags(s: Any) -> list[str]:
    if not s:
        return []
    if isinstance(s, list):
        return _normalize_tags(s)
    return _normalize_tags(list(str(s).split(",")))


@router.post("/datasets/{dataset_id}/import")
async def import_rows(
    dataset_id: str,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> dict:
    d = session.get(Dataset, dataset_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    name = (file.filename or "").lower()
    errors: list[str] = []
    parsed: list[dict[str, Any]] = []
    try:
        if name.endswith(".json") or raw.lstrip().startswith(b"["):
            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, list):
                raise HTTPException(status_code=400, detail="JSON must be an array")
            for i, item in enumerate(data):
                if not isinstance(item, dict):
                    errors.append(f"row {i}: not an object")
                    continue
                parsed.append(item)
        else:
            text = raw.decode("utf-8", errors="replace")
            reader = csv.DictReader(io.StringIO(text))
            parsed.extend(reader)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Parse failed: {exc}") from exc

    pos = _next_position(session, dataset_id)
    imported = 0
    for i, item in enumerate(parsed):
        q = str(item.get("question") or "").strip()
        if not q:
            errors.append(f"row {i}: missing question")
            continue
        row = DatasetRow(
            dataset_id=dataset_id,
            position=pos,
            question=q,
            expected_response=item.get("expected_response") or None,
            chatbot_response=item.get("chatbot_response") or None,
            tags_json=json.dumps(_parse_csv_tags(item.get("tags"))),
            category=item.get("category") or None,
        )
        session.add(row)
        pos += 1
        imported += 1
    session.commit()
    return {"imported": imported, "errors": errors}


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


def _matches_tag_filter(row_tags: list[str], filter_tags: list[str]) -> bool:
    if not filter_tags:
        return True
    return any(t in row_tags for t in filter_tags)


async def _fetch_from_endpoint(
    ep: ChatbotEndpoint,
    question: str,
    turns: list[dict[str, str]] | None = None,
) -> tuple[str | None, tuple[int, int, int]]:
    """Call a configured ChatbotEndpoint and return ``(text, (p, c, t))``.

    Delegates to the shared ``call_chatbot`` so the connector behaves identically
    here and in the "Test connection" route. ``turns`` replays a multi-turn
    transcript (rendered via ``{{messages}}``); ``None`` sends a single-turn
    message built from ``question``.
    """
    return await call_chatbot(ep, question=question, turns=turns)


async def _run_worker(run_id: str) -> None:
    """Background worker for a DatasetRun. Uses its own DB session."""
    from sqlmodel import Session as SMSession

    sem = asyncio.Semaphore(4)

    def _set_status(status: str, *, error: str | None = None) -> None:
        with SMSession(db_engine) as s:
            r = s.get(DatasetRun, run_id)
            if r is None:
                return
            r.status = status
            if error is not None:
                r.error = error
            if status in ("completed", "failed", "cancelled"):
                r.finished_at = datetime.utcnow()
            s.add(r)
            s.commit()

    try:
        with SMSession(db_engine) as s:
            run = s.get(DatasetRun, run_id)
            if run is None:
                return
            rows = s.exec(
                select(DatasetRow)
                .where(DatasetRow.dataset_id == run.dataset_id)
                .order_by(DatasetRow.position.asc())
            ).all()
            tag_filter = json.loads(run.tag_filter_json or "[]")
            target_rows = [
                r for r in rows if _matches_tag_filter(_parse_tags(r.tags_json), tag_filter)
            ]
            method = run.method
            ai_provider = run.ai_provider
            project_id = run.project_id
            chatbot_endpoint_id = run.chatbot_endpoint_id
            row_payload = [
                (
                    r.id,
                    r.question,
                    r.expected_response,
                    r.chatbot_response,
                    r.chatbot_source,
                    r.turns_json,
                )
                for r in target_rows
            ]

        _set_status("running")

        async def _process(
            rid: str,
            q: str,
            expected: str | None,
            chat_resp: str | None,
            chatbot_source: str | None,
            turns_json: str = "[]",
        ):
            async with sem:
                # Check for cancellation
                with SMSession(db_engine) as s:
                    cur = s.get(DatasetRun, run_id)
                    if cur is None or cur.status == "cancelled":
                        return

                err: str | None = None
                evaluation_id: str | None = None
                # Resolve per-row source preference:
                #   - "manual": always use the stored chatbot_response text
                #   - "endpoint:<id>": fetch from that specific endpoint
                #   - None: defer to the run's default endpoint (existing behavior)
                row_endpoint_id: str | None = None
                force_manual = False
                if chatbot_source:
                    src = chatbot_source.strip().lower()
                    if src == "manual":
                        force_manual = True
                    elif src.startswith("endpoint:"):
                        row_endpoint_id = src.split(":", 1)[1].strip() or None

                row_turns = _parse_turns(turns_json)
                turns_payload = (
                    [{"role": t.role, "content": t.content} for t in row_turns]
                    if row_turns
                    else None
                )

                effective_endpoint_id = (
                    None if force_manual else (row_endpoint_id or chatbot_endpoint_id)
                )

                response_text = chat_resp if force_manual else (chat_resp or None)
                cb_tokens: tuple[int, int, int] = (0, 0, 0)
                try:
                    if not response_text and effective_endpoint_id:
                        with SMSession(db_engine) as s:
                            ep = s.get(ChatbotEndpoint, effective_endpoint_id)
                            if ep is not None:
                                response_text, cb_tokens = await _fetch_from_endpoint(
                                    ep, q, turns=turns_payload
                                )
                    if not response_text:
                        err = (
                            "no chatbot_response (set the row's chatbot_response, "
                            "pick a row-level endpoint, or select a chatbot_endpoint_id "
                            "for this run)"
                        )
                    else:
                        with SMSession(db_engine) as s:
                            result = await run_evaluation_core(
                                session=s,
                                project_id=project_id,
                                question=q,
                                chatbot_response=response_text,
                                method=method,  # type: ignore[arg-type]
                                ai_provider=ai_provider,
                                reference_answer=expected,
                                run_type="dataset",
                                chatbot_tokens=cb_tokens,
                            )
                            evaluation_id = result.id
                except HTTPException as ex:
                    err = str(ex.detail)
                except Exception as ex:
                    err = f"{type(ex).__name__}: {ex}"

                with SMSession(db_engine) as s:
                    # Pull token usage off the persisted Evaluation row so the
                    # DatasetRunItem mirrors what the eval row records (judge +
                    # reference). Chatbot tokens come from the endpoint call we
                    # made above.
                    j_p = j_c = j_t = 0
                    r_p = r_c = r_t = 0
                    if evaluation_id:
                        ev = s.get(Evaluation, evaluation_id)
                        if ev is not None:
                            j_p = int(ev.judge_prompt_tokens or 0)
                            j_c = int(ev.judge_completion_tokens or 0)
                            j_t = int(ev.judge_total_tokens or 0)
                            r_p = int(ev.reference_prompt_tokens or 0)
                            r_c = int(ev.reference_completion_tokens or 0)
                            r_t = int(ev.reference_total_tokens or 0)
                    cb_p, cb_c, cb_t = cb_tokens
                    item = DatasetRunItem(
                        dataset_run_id=run_id,
                        dataset_row_id=rid,
                        evaluation_id=evaluation_id,
                        error=err,
                        judge_prompt_tokens=j_p or None,
                        judge_completion_tokens=j_c or None,
                        judge_total_tokens=j_t or None,
                        reference_prompt_tokens=r_p or None,
                        reference_completion_tokens=r_c or None,
                        reference_total_tokens=r_t or None,
                        chatbot_prompt_tokens=int(cb_p) or None,
                        chatbot_completion_tokens=int(cb_c) or None,
                        chatbot_total_tokens=int(cb_t) or None,
                    )
                    s.add(item)
                    r = s.get(DatasetRun, run_id)
                    if r is not None:
                        r.completed_rows = (r.completed_rows or 0) + 1
                        s.add(r)
                    s.commit()

        await asyncio.gather(*[_process(*r) for r in row_payload], return_exceptions=False)

        with SMSession(db_engine) as s:
            r = s.get(DatasetRun, run_id)
            if r is not None and r.status != "cancelled":
                r.status = "completed"
                r.finished_at = datetime.utcnow()
                s.add(r)
                s.commit()
    except Exception as exc:
        _set_status("failed", error=f"{type(exc).__name__}: {exc}")


@router.post("/datasets/{dataset_id}/run", response_model=DatasetRunOut, status_code=202)
async def start_run(
    dataset_id: str,
    payload: DatasetRunRequest,
    session: Session = Depends(get_session),
) -> DatasetRunOut:
    d = session.get(Dataset, dataset_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if payload.method not in ("ml", "ai", "both"):
        raise HTTPException(status_code=400, detail="method must be ml|ai|both")
    rows = session.exec(select(DatasetRow).where(DatasetRow.dataset_id == dataset_id)).all()
    tag_filter = [t.lower() for t in (payload.tag_filter or [])]
    target = [r for r in rows if _matches_tag_filter(_parse_tags(r.tags_json), tag_filter)]
    if not target:
        raise HTTPException(status_code=400, detail="No rows match the filter")
    ep_id = (payload.chatbot_endpoint_id or "").strip() or None
    if ep_id is not None:
        ep = session.get(ChatbotEndpoint, ep_id)
        if ep is None or ep.project_id != d.project_id:
            raise HTTPException(
                status_code=400,
                detail="chatbot_endpoint_id must belong to the same project",
            )
    run = DatasetRun(
        dataset_id=dataset_id,
        project_id=d.project_id,
        name=(payload.name or "").strip() or None,
        method=payload.method,
        ai_provider=payload.ai_provider,
        tag_filter_json=json.dumps(tag_filter),
        status="pending",
        total_rows=len(target),
        completed_rows=0,
        chatbot_endpoint_id=ep_id,
    )
    session.add(run)
    session.commit()
    session.refresh(run)

    task = asyncio.create_task(_run_worker(run.id))
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)

    return _run_to_out(session, run)


class RunAllDatasetsRequest(BaseModel):
    name: str | None = None
    method: EvaluationMethod = "ai"
    ai_provider: str | None = None
    tag_filter: list[str] = []
    chatbot_endpoint_id: str | None = None


class RunAllDatasetsResponse(BaseModel):
    name: str | None
    runs: list[DatasetRunOut]


@router.post(
    "/projects/{project_id}/run-all-datasets",
    response_model=RunAllDatasetsResponse,
    status_code=202,
)
async def start_run_all_datasets(
    project_id: str,
    payload: RunAllDatasetsRequest,
    session: Session = Depends(get_session),
) -> RunAllDatasetsResponse:
    """Create one DatasetRun per dataset in the project, all sharing the same
    `name` so the client can render them as a single cascade card."""
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if payload.method not in ("ml", "ai", "both"):
        raise HTTPException(status_code=400, detail="method must be ml|ai|both")

    datasets = session.exec(
        select(Dataset).where(Dataset.project_id == project_id)
    ).all()
    if not datasets:
        raise HTTPException(status_code=400, detail="No datasets in this project")

    ep_id = (payload.chatbot_endpoint_id or "").strip() or None
    if ep_id is not None:
        ep = session.get(ChatbotEndpoint, ep_id)
        if ep is None or ep.project_id != project_id:
            raise HTTPException(
                status_code=400,
                detail="chatbot_endpoint_id must belong to the same project",
            )

    shared_name = (payload.name or "").strip() or None
    tag_filter = [t.lower() for t in (payload.tag_filter or [])]

    created: list[DatasetRun] = []
    for d in datasets:
        rows = session.exec(
            select(DatasetRow).where(DatasetRow.dataset_id == d.id)
        ).all()
        target = [r for r in rows if _matches_tag_filter(_parse_tags(r.tags_json), tag_filter)]
        if not target:
            continue
        run = DatasetRun(
            dataset_id=d.id,
            project_id=project_id,
            name=shared_name,
            method=payload.method,
            ai_provider=payload.ai_provider,
            tag_filter_json=json.dumps(tag_filter),
            status="pending",
            total_rows=len(target),
            completed_rows=0,
            chatbot_endpoint_id=ep_id,
        )
        session.add(run)
        created.append(run)

    if not created:
        raise HTTPException(status_code=400, detail="No rows in any dataset match the filter")
    session.commit()
    for run in created:
        session.refresh(run)
        task = asyncio.create_task(_run_worker(run.id))
        _BACKGROUND_TASKS.add(task)
        task.add_done_callback(_BACKGROUND_TASKS.discard)

    return RunAllDatasetsResponse(
        name=shared_name,
        runs=[_run_to_out(session, r) for r in created],
    )


def _run_to_out(session: Session, run: DatasetRun, *, with_items: bool = False) -> DatasetRunOut:
    items: list[DatasetRunItemOut] = []
    summary: DatasetRunSummary | None = None
    item_rows = session.exec(
        select(DatasetRunItem).where(DatasetRunItem.dataset_run_id == run.id)
    ).all()
    # Build summary always (cheap-ish for MVP)
    scores: list[float] = []
    by_tag_acc: dict[str, list[float]] = {}
    by_cat_acc: dict[str, list[float]] = {}
    total_judge = 0
    total_ref = 0
    total_cb = 0
    for it in item_rows:
        row = session.get(DatasetRow, it.dataset_row_id)
        tags = _parse_tags(row.tags_json) if row else []
        category = row.category if row else None
        question = row.question if row else None
        ev = session.get(Evaluation, it.evaluation_id) if it.evaluation_id else None
        combined = float(ev.combined_score) if ev and ev.combined_score is not None else None
        ml_s = float(ev.ml_score) if ev and ev.ml_score is not None else None
        ai_s = float(ev.ai_score) if ev and ev.ai_score is not None else None
        if combined is not None:
            scores.append(combined)
            for t in tags:
                by_tag_acc.setdefault(t, []).append(combined)
            if category:
                by_cat_acc.setdefault(category, []).append(combined)
        it_judge = int(it.judge_total_tokens or 0)
        it_ref = int(it.reference_total_tokens or 0)
        it_cb = int(it.chatbot_total_tokens or 0)
        it_total = it_judge + it_ref + it_cb
        total_judge += it_judge
        total_ref += it_ref
        total_cb += it_cb
        items.append(
            DatasetRunItemOut(
                id=it.id,
                dataset_row_id=it.dataset_row_id,
                evaluation_id=it.evaluation_id,
                error=it.error,
                question=question,
                tags=tags,
                category=category,
                combined_score=combined,
                ml_score=ml_s,
                ai_score=ai_s,
                judge_total_tokens=it_judge or None,
                reference_total_tokens=it_ref or None,
                chatbot_total_tokens=it_cb or None,
                total_tokens=it_total or None,
            )
        )

    def _agg(vals: list[float]) -> tuple[float | None, float | None]:
        if not vals:
            return None, None
        avg = sum(vals) / len(vals)
        passed = sum(1 for v in vals if v >= 75) / len(vals)
        return avg, passed

    avg, pass_rate = _agg(scores)
    by_tag = []
    for t, vs in sorted(by_tag_acc.items()):
        a, p = _agg(vs)
        by_tag.append(TagSummary(tag=t, count=len(vs), avg_combined=a, pass_rate=p))
    by_cat = []
    for c, vs in sorted(by_cat_acc.items()):
        a, p = _agg(vs)
        by_cat.append(CategorySummary(category=c, count=len(vs), avg_combined=a, pass_rate=p))
    summary = DatasetRunSummary(
        avg_combined=avg,
        pass_rate=pass_rate,
        total_rows=run.total_rows,
        by_tag=by_tag,
        by_category=by_cat,
        total_judge_tokens=total_judge,
        total_reference_tokens=total_ref,
        total_chatbot_tokens=total_cb,
        total_tokens=total_judge + total_ref + total_cb,
    )

    ep_name: str | None = None
    ep_url: str | None = None
    if run.chatbot_endpoint_id:
        ep = session.get(ChatbotEndpoint, run.chatbot_endpoint_id)
        if ep is not None:
            ep_name = ep.name
            ep_url = ep.url
    return DatasetRunOut(
        id=run.id,
        dataset_id=run.dataset_id,
        project_id=run.project_id,
        name=run.name,
        method=run.method,
        ai_provider=run.ai_provider,
        status=run.status,
        started_at=run.started_at,
        finished_at=run.finished_at,
        total_rows=run.total_rows,
        completed_rows=run.completed_rows,
        error=run.error,
        chatbot_endpoint_id=run.chatbot_endpoint_id,
        chatbot_endpoint_name=ep_name,
        chatbot_endpoint_url=ep_url,
        items=items,
        summary=summary,
    )


@router.get("/dataset-runs/{run_id}", response_model=DatasetRunOut)
def get_run(
    run_id: str,
    session: Session = Depends(get_session),
) -> DatasetRunOut:
    run = session.get(DatasetRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return _run_to_out(session, run, with_items=True)


@router.get("/datasets/{dataset_id}/runs", response_model=list[DatasetRunOut])
def list_runs_by_dataset(
    dataset_id: str,
    session: Session = Depends(get_session),
) -> list[DatasetRunOut]:
    """List all runs for a single dataset, newest first. Powers the
    per-dataset run-history section in the UI."""
    d = session.get(Dataset, dataset_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    rows = session.exec(
        select(DatasetRun)
        .where(DatasetRun.dataset_id == dataset_id)
        .order_by(DatasetRun.started_at.desc())
    ).all()
    return [_run_to_out(session, r) for r in rows]


@router.get("/projects/{project_id}/dataset-runs", response_model=list[DatasetRunOut])
def list_runs_by_project(
    project_id: str,
    session: Session = Depends(get_session),
) -> list[DatasetRunOut]:
    rows = session.exec(
        select(DatasetRun)
        .where(DatasetRun.project_id == project_id)
        .order_by(DatasetRun.started_at.desc())
    ).all()
    return [_run_to_out(session, r) for r in rows]


@router.post("/datasets/{dataset_id}/runs/{run_id}/cancel", response_model=DatasetRunOut)
def cancel_run(
    dataset_id: str,
    run_id: str,
    session: Session = Depends(get_session),
) -> DatasetRunOut:
    run = session.get(DatasetRun, run_id)
    if run is None or run.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status in ("pending", "running"):
        run.status = "cancelled"
        run.finished_at = datetime.utcnow()
        session.add(run)
        session.commit()
        session.refresh(run)
    return _run_to_out(session, run)


# ---------------------------------------------------------------------------
# Heatmap (Feature #5 — live per-row dimension scores during a run)
# ---------------------------------------------------------------------------


_HEATMAP_DIMS = ("similarity", "accuracy", "completeness", "relevance", "readability")
_HEATMAP_PASS_THRESHOLD = 75.0


class HeatmapRow(BaseModel):
    row_id: str
    position: int
    question: str
    tags: list[str] = []
    category: str | None = None
    status: Literal["completed", "pending", "error"]
    combined_score: float | None = None
    passed: bool | None = None
    dimensions: dict[str, float] = {}
    engine_scores: dict[str, float] = {}
    error: str | None = None


class HeatmapResponse(BaseModel):
    run_id: str
    status: str
    total_rows: int
    completed_rows: int
    passing_rows: int
    rows: list[HeatmapRow] = []


@router.get("/dataset-runs/{run_id}/heatmap", response_model=HeatmapResponse)
def get_run_heatmap(
    run_id: str,
    session: Session = Depends(get_session),
) -> HeatmapResponse:
    """Per-row dimension scores for the Batch Run heatmap UI.

    Pending rows (no matching DatasetRunItem yet) are returned with
    ``status="pending"`` so the heatmap can show spinner cells. Rows with a
    persisted error get ``status="error"`` and include the error text.
    """
    run = session.get(DatasetRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")

    # All dataset rows that *should* appear, respecting the same tag filter
    # the run was started with (so pending placeholders are accurate).
    all_rows = session.exec(
        select(DatasetRow)
        .where(DatasetRow.dataset_id == run.dataset_id)
        .order_by(DatasetRow.position.asc())
    ).all()
    try:
        tag_filter = json.loads(run.tag_filter_json or "[]")
        if not isinstance(tag_filter, list):
            tag_filter = []
    except Exception:
        tag_filter = []
    target_rows = [
        r for r in all_rows if _matches_tag_filter(_parse_tags(r.tags_json), tag_filter)
    ]

    items = session.exec(
        select(DatasetRunItem).where(DatasetRunItem.dataset_run_id == run_id)
    ).all()
    items_by_row: dict[str, DatasetRunItem] = {it.dataset_row_id: it for it in items}

    out_rows: list[HeatmapRow] = []
    passing = 0
    for r in target_rows:
        it = items_by_row.get(r.id)
        tags = _parse_tags(r.tags_json)
        if it is None:
            out_rows.append(
                HeatmapRow(
                    row_id=r.id,
                    position=r.position,
                    question=r.question,
                    tags=tags,
                    category=r.category,
                    status="pending",
                )
            )
            continue

        if it.error or it.evaluation_id is None:
            out_rows.append(
                HeatmapRow(
                    row_id=r.id,
                    position=r.position,
                    question=r.question,
                    tags=tags,
                    category=r.category,
                    status="error",
                    error=it.error or "no evaluation recorded",
                )
            )
            continue

        ev = session.get(Evaluation, it.evaluation_id)
        if ev is None:
            out_rows.append(
                HeatmapRow(
                    row_id=r.id,
                    position=r.position,
                    question=r.question,
                    tags=tags,
                    category=r.category,
                    status="error",
                    error="evaluation row missing",
                )
            )
            continue

        # Per-dimension scores. Prefer AI engine values when available,
        # falling back to ML, so the heatmap stays populated for any method.
        metric_rows = session.exec(
            select(MetricScore).where(MetricScore.evaluation_id == ev.id)
        ).all()
        ai_dims = {
            m.metric_name: float(m.value)
            for m in metric_rows
            if m.engine == "ai" and m.metric_name in _HEATMAP_DIMS
        }
        ml_dims = {
            m.metric_name: float(m.value)
            for m in metric_rows
            if m.engine == "ml" and m.metric_name in _HEATMAP_DIMS
        }
        dims: dict[str, float] = {}
        for d in _HEATMAP_DIMS:
            if d in ai_dims:
                dims[d] = ai_dims[d]
            elif d in ml_dims:
                dims[d] = ml_dims[d]

        engine_scores: dict[str, float] = {}
        if ev.ml_score is not None:
            engine_scores["ml"] = float(ev.ml_score)
        if ev.ai_score is not None:
            engine_scores["ai"] = float(ev.ai_score)

        combined = float(ev.combined_score) if ev.combined_score is not None else None
        passed = combined is not None and combined >= _HEATMAP_PASS_THRESHOLD
        if passed:
            passing += 1

        out_rows.append(
            HeatmapRow(
                row_id=r.id,
                position=r.position,
                question=r.question,
                tags=tags,
                category=r.category,
                status="completed",
                combined_score=combined,
                passed=passed,
                dimensions=dims,
                engine_scores=engine_scores,
            )
        )

    completed = sum(1 for x in out_rows if x.status in ("completed", "error"))
    return HeatmapResponse(
        run_id=run.id,
        status=run.status,
        total_rows=run.total_rows or len(target_rows),
        completed_rows=completed,
        passing_rows=passing,
        rows=out_rows,
    )


# ---------------------------------------------------------------------------
# Schedule (SCHEDULE_DISABLED — no-op endpoints retained for re-enable)
# ---------------------------------------------------------------------------


_SCHEDULE_DISABLED_PAYLOAD = {
    "enabled": False,
    "cron": None,
    "message": "Scheduling is disabled in this build",
}


# SCHEDULE_DISABLED
@router.get("/datasets/{dataset_id}/schedule")
def get_schedule(
    dataset_id: str,
    session: Session = Depends(get_session),
) -> dict:
    # SCHEDULE_DISABLED — no-op; underlying DatasetSchedule table is retained.
    return dict(_SCHEDULE_DISABLED_PAYLOAD)


# SCHEDULE_DISABLED
@router.post("/datasets/{dataset_id}/schedule")
def set_schedule(
    dataset_id: str,
    payload: DatasetScheduleIn,
    session: Session = Depends(get_session),
) -> dict:
    # SCHEDULE_DISABLED — silently ignores writes.
    return dict(_SCHEDULE_DISABLED_PAYLOAD)
