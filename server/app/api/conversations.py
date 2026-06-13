from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..engines import ai as ai_engine, rag as rag_engine
from ..engines.judges import JudgeParseError, MissingProviderCredentialsError
from ..engines.pii import filter_allowed, scan_pii
# CUSTOM_CHECKS_DISABLED — CustomCheck import removed; restore to re-enable.
from ..models import (
    Conversation,
    ConversationEvaluation,
    GuidelineFinding,
    Message,
    MetricScore,
    Project,
    TurnEvaluation,
)
from ..scoring import (
    DEFAULT_WEIGHTS,
    combine_judge,
)
from ..services.reference import load_guideline_texts

router = APIRouter()


Role = Literal["system", "user", "assistant", "tool"]
EvaluationMethod = Literal["ml", "ai", "both"]


# --- Schemas ---------------------------------------------------------------


class MessageIn(BaseModel):
    role: Role
    content: str = ""
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None
    expected_response: str | None = None


class MessageOut(BaseModel):
    id: str
    conversation_id: str
    position: int
    role: Role
    content: str
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None
    expected_response: str | None = None
    created_at: datetime


class ConversationCreate(BaseModel):
    title: str
    messages: list[MessageIn] | None = None


class ConversationUpdate(BaseModel):
    title: str


class ConversationRead(BaseModel):
    id: str
    project_id: str
    title: str
    created_at: datetime
    messages: list[MessageOut] = []


class ConversationSummary(BaseModel):
    id: str
    project_id: str
    title: str
    created_at: datetime
    message_count: int


class ReorderRequest(BaseModel):
    position: int


class ConversationEvaluateRequest(BaseModel):
    method: EvaluationMethod = "both"
    ai_provider: str | None = None


class GuidelineFindingOut(BaseModel):
    guideline_excerpt: str
    offending_span: str
    reason: str
    severity: str | None = None


class MetricScoreOut(BaseModel):
    engine: Literal["ml", "ai"]
    metric_name: str
    value: float
    weight: float = 0.0


class DimensionBreakdown(BaseModel):
    similarity: float = 0.0
    accuracy: float = 0.0
    completeness: float = 0.0
    relevance: float = 0.0
    readability: float = 0.0


class PIIHitOut(BaseModel):
    kind: Literal["email", "phone", "ssn", "cc"]
    span: str
    start: int
    end: int


class CustomCheckResultOut(BaseModel):
    id: str
    description: str
    score: float
    passed: bool
    reason: str
    weight: float = 0.0


class TurnEvaluationOut(BaseModel):
    id: str
    message_id: str
    position: int
    user_prompt: str
    assistant_response: str
    reference_answer: str
    ml_score: float | None = None
    ai_score: float | None = None
    combined_score: float | None = None
    rationale: str | None = None
    ml_dimensions: DimensionBreakdown | None = None
    ai_dimensions: DimensionBreakdown | None = None
    ml_metrics: list[MetricScoreOut] = []
    ai_metrics: list[MetricScoreOut] = []
    guideline_findings: list[GuidelineFindingOut] = []
    retrieved_chunks: list[dict] = []
    refusal_mode: bool = False
    pii_hits: list[PIIHitOut] = []
    custom_check_results: list[CustomCheckResultOut] = []
    judge_prompt_tokens: int | None = None
    judge_completion_tokens: int | None = None
    judge_total_tokens: int | None = None
    reference_prompt_tokens: int | None = None
    reference_completion_tokens: int | None = None
    reference_total_tokens: int | None = None
    chatbot_prompt_tokens: int | None = None
    chatbot_completion_tokens: int | None = None
    chatbot_total_tokens: int | None = None


class ConversationEvaluationSummary(BaseModel):
    average_combined: float | None = None
    min_combined: float | None = None
    max_combined: float | None = None
    turn_count: int


class ConversationEvaluationOut(BaseModel):
    id: str
    conversation_id: str
    method: EvaluationMethod
    ai_provider: str | None = None
    created_at: datetime
    turn_evaluations: list[TurnEvaluationOut] = []
    summary: ConversationEvaluationSummary


# --- Helpers ---------------------------------------------------------------


def _parse_tool_calls(s: str | None) -> list[dict[str, Any]] | None:
    if not s:
        return None
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return None


def _serialize_tool_calls(tc: list[dict[str, Any]] | None) -> str | None:
    if tc is None:
        return None
    return json.dumps(tc)


def _msg_out(m: Message) -> MessageOut:
    return MessageOut(
        id=m.id,
        conversation_id=m.conversation_id,
        position=m.position,
        role=m.role,  # type: ignore[arg-type]
        content=m.content,
        tool_calls=_parse_tool_calls(m.tool_calls_json),
        tool_call_id=m.tool_call_id,
        expected_response=m.expected_response,
        created_at=m.created_at,
    )


def _ordered_messages(session: Session, conversation_id: str) -> list[Message]:
    return list(
        session.exec(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.position.asc())
        ).all()
    )


def _ensure_conversation(session: Session, conversation_id: str) -> Conversation:
    conv = session.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


def _render_transcript(messages: list[Message]) -> str:
    parts: list[str] = []
    for m in messages:
        role = m.role
        if role == "tool":
            tag = "tool"
            if m.tool_call_id:
                tag = f"tool[id={m.tool_call_id}]"
            parts.append(f"{tag}: {m.content}")
        elif role == "assistant" and m.tool_calls_json:
            tc = _parse_tool_calls(m.tool_calls_json) or []
            names = ", ".join(str(c.get("name", "?")) for c in tc) or "?"
            content = m.content or ""
            parts.append(f"assistant (tool_calls=[{names}]): {content}")
        else:
            parts.append(f"{role}: {m.content}")
    return "\n".join(parts)


# --- CRUD: Conversations ----------------------------------------------------


@router.post(
    "/projects/{project_id}/conversations",
    response_model=ConversationRead,
    status_code=201,
)
def create_conversation(
    project_id: str,
    payload: ConversationCreate,
    session: Session = Depends(get_session),
) -> ConversationRead:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    conv = Conversation(project_id=project_id, title=payload.title)
    session.add(conv)
    session.commit()
    session.refresh(conv)

    msgs: list[Message] = []
    if payload.messages:
        for i, m in enumerate(payload.messages):
            row = Message(
                conversation_id=conv.id,
                position=i,
                role=m.role,
                content=m.content,
                tool_calls_json=_serialize_tool_calls(m.tool_calls),
                tool_call_id=m.tool_call_id,
            )
            session.add(row)
            msgs.append(row)
        session.commit()
        for row in msgs:
            session.refresh(row)

    return ConversationRead(
        id=conv.id,
        project_id=conv.project_id,
        title=conv.title,
        created_at=conv.created_at,
        messages=[_msg_out(m) for m in msgs],
    )


@router.get(
    "/projects/{project_id}/conversations",
    response_model=list[ConversationSummary],
)
def list_conversations(
    project_id: str,
    session: Session = Depends(get_session),
) -> list[ConversationSummary]:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    rows = session.exec(
        select(Conversation)
        .where(Conversation.project_id == project_id)
        .order_by(Conversation.created_at.desc())
    ).all()
    out: list[ConversationSummary] = []
    for c in rows:
        count = len(session.exec(select(Message).where(Message.conversation_id == c.id)).all())
        out.append(
            ConversationSummary(
                id=c.id,
                project_id=c.project_id,
                title=c.title,
                created_at=c.created_at,
                message_count=count,
            )
        )
    return out


@router.get("/conversations/{conversation_id}", response_model=ConversationRead)
def get_conversation(
    conversation_id: str,
    session: Session = Depends(get_session),
) -> ConversationRead:
    conv = _ensure_conversation(session, conversation_id)
    msgs = _ordered_messages(session, conversation_id)
    return ConversationRead(
        id=conv.id,
        project_id=conv.project_id,
        title=conv.title,
        created_at=conv.created_at,
        messages=[_msg_out(m) for m in msgs],
    )


@router.patch("/conversations/{conversation_id}", response_model=ConversationRead)
def update_conversation(
    conversation_id: str,
    payload: ConversationUpdate,
    session: Session = Depends(get_session),
) -> ConversationRead:
    conv = _ensure_conversation(session, conversation_id)
    conv.title = payload.title
    session.add(conv)
    session.commit()
    session.refresh(conv)
    msgs = _ordered_messages(session, conversation_id)
    return ConversationRead(
        id=conv.id,
        project_id=conv.project_id,
        title=conv.title,
        created_at=conv.created_at,
        messages=[_msg_out(m) for m in msgs],
    )


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: str,
    session: Session = Depends(get_session),
) -> None:
    conv = _ensure_conversation(session, conversation_id)

    conv_evals = session.exec(
        select(ConversationEvaluation).where(
            ConversationEvaluation.conversation_id == conversation_id
        )
    ).all()
    conv_eval_ids = [ce.id for ce in conv_evals]
    if conv_eval_ids:
        turn_evals = session.exec(
            select(TurnEvaluation).where(
                TurnEvaluation.conversation_evaluation_id.in_(conv_eval_ids)
            )
        ).all()
        turn_eval_ids = [te.id for te in turn_evals]
        if turn_eval_ids:
            for ms in session.exec(
                select(MetricScore).where(MetricScore.turn_evaluation_id.in_(turn_eval_ids))
            ).all():
                session.delete(ms)
            for gf in session.exec(
                select(GuidelineFinding).where(
                    GuidelineFinding.turn_evaluation_id.in_(turn_eval_ids)
                )
            ).all():
                session.delete(gf)
        for te in turn_evals:
            session.delete(te)
    for ce in conv_evals:
        session.delete(ce)

    for m in session.exec(select(Message).where(Message.conversation_id == conversation_id)).all():
        session.delete(m)

    session.delete(conv)
    session.commit()


# --- CRUD: Messages ---------------------------------------------------------


@router.post(
    "/conversations/{conversation_id}/messages",
    response_model=MessageOut,
    status_code=201,
)
def append_message(
    conversation_id: str,
    payload: MessageIn,
    session: Session = Depends(get_session),
) -> MessageOut:
    _ensure_conversation(session, conversation_id)
    msgs = _ordered_messages(session, conversation_id)
    pos = len(msgs)
    row = Message(
        conversation_id=conversation_id,
        position=pos,
        role=payload.role,
        content=payload.content,
        tool_calls_json=_serialize_tool_calls(payload.tool_calls),
        tool_call_id=payload.tool_call_id,
        expected_response=(
            payload.expected_response.strip()
            if payload.expected_response and payload.expected_response.strip()
            else None
        ),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _msg_out(row)


@router.put(
    "/conversations/{conversation_id}/messages/{message_id}",
    response_model=MessageOut,
)
def update_message(
    conversation_id: str,
    message_id: str,
    payload: MessageIn,
    session: Session = Depends(get_session),
) -> MessageOut:
    _ensure_conversation(session, conversation_id)
    row = session.get(Message, message_id)
    if row is None or row.conversation_id != conversation_id:
        raise HTTPException(status_code=404, detail="Message not found")
    row.role = payload.role
    row.content = payload.content
    row.tool_calls_json = _serialize_tool_calls(payload.tool_calls)
    row.tool_call_id = payload.tool_call_id
    row.expected_response = (
        payload.expected_response.strip()
        if payload.expected_response and payload.expected_response.strip()
        else None
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _msg_out(row)


@router.patch(
    "/conversations/{conversation_id}/messages/{message_id}/reorder",
    response_model=list[MessageOut],
)
def reorder_message(
    conversation_id: str,
    message_id: str,
    payload: ReorderRequest,
    session: Session = Depends(get_session),
) -> list[MessageOut]:
    _ensure_conversation(session, conversation_id)
    msgs = _ordered_messages(session, conversation_id)
    target = next((m for m in msgs if m.id == message_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Message not found")

    new_pos = max(0, min(payload.position, len(msgs) - 1))
    others = [m for m in msgs if m.id != message_id]
    others.insert(new_pos, target)
    for i, m in enumerate(others):
        if m.position != i:
            m.position = i
            session.add(m)
    session.commit()
    refreshed = _ordered_messages(session, conversation_id)
    return [_msg_out(m) for m in refreshed]


@router.delete(
    "/conversations/{conversation_id}/messages/{message_id}",
    status_code=204,
)
def delete_message(
    conversation_id: str,
    message_id: str,
    session: Session = Depends(get_session),
) -> None:
    _ensure_conversation(session, conversation_id)
    row = session.get(Message, message_id)
    if row is None or row.conversation_id != conversation_id:
        raise HTTPException(status_code=404, detail="Message not found")
    session.delete(row)
    session.commit()

    # Compact positions
    remaining = _ordered_messages(session, conversation_id)
    for i, m in enumerate(remaining):
        if m.position != i:
            m.position = i
            session.add(m)
    session.commit()


# --- Multi-turn evaluation --------------------------------------------------


_AI_DIMS = (
    "similarity",
    "accuracy",
    "completeness",
    "relevance",
    "readability",
    "factual_consistency",
    "numeric_consistency",
    "refusal_appropriateness",
)


def _ai_metric_rows(jr) -> list[MetricScore]:
    rows: list[MetricScore] = []
    for d in _AI_DIMS:
        rows.append(
            MetricScore(
                engine="ai",
                metric_name=d,
                value=float(getattr(jr, d, 0.0) or 0.0),
                weight=float(DEFAULT_WEIGHTS.get(d, 0.0)),
            )
        )
    return rows


@router.post(
    "/conversations/{conversation_id}/evaluate",
    response_model=ConversationEvaluationOut,
)
async def evaluate_conversation(
    conversation_id: str,
    payload: ConversationEvaluateRequest,
    session: Session = Depends(get_session),
) -> ConversationEvaluationOut:
    conv = _ensure_conversation(session, conversation_id)
    # Method field retained for backward compat — only the AI judge runs.

    msgs = _ordered_messages(session, conversation_id)
    assistant_indices = [
        i for i, m in enumerate(msgs) if m.role == "assistant" and m.content.strip()
    ]
    if not assistant_indices:
        raise HTTPException(
            status_code=400,
            detail="Conversation has no assistant messages to evaluate.",
        )

    guideline_texts = load_guideline_texts(session, conv.project_id)
    # CUSTOM_CHECKS_DISABLED — loading + passing custom checks is disabled.
    # Restore the block below to re-enable.
    # custom_check_rows = list(
    #     session.exec(
    #         select(CustomCheck)
    #         .where(CustomCheck.project_id == conv.project_id)
    #         .order_by(CustomCheck.created_at)
    #     ).all()
    # )
    # custom_checks_payload: list[dict] = [
    #     {"id": c.id, "description": c.description} for c in custom_check_rows
    # ]
    # custom_check_by_id: dict[str, CustomCheck] = {c.id: c for c in custom_check_rows}
    custom_check_rows: list = []
    custom_checks_payload: list[dict] = []
    custom_check_by_id: dict = {}
    sem = asyncio.Semaphore(4)

    plans: list[dict[str, Any]] = []
    for idx in assistant_indices:
        prior = msgs[:idx]
        last_user = next(
            (m.content for m in reversed(prior) if m.role == "user"),
            "",
        )
        user_prompt = last_user.strip() or _render_transcript(prior)[-500:]
        plans.append(
            {
                "message": msgs[idx],
                "position": msgs[idx].position,
                "user_prompt": user_prompt,
                "prior_context": _render_transcript(prior),
            }
        )

    async def _run_turn(plan: dict[str, Any]) -> dict[str, Any]:
        async with sem:
            user_prompt = plan["user_prompt"]
            prior_context = plan["prior_context"]
            assistant_message: Message = plan["message"]
            user_expected = (assistant_message.expected_response or "").strip()
            # Reference: prefer user-supplied expected over the generated one
            # so the judge grades against what the human actually wants.
            if user_expected:
                reference_text = user_expected
                retrieved_chunks: list[dict[str, Any]] = []
                ref_tokens = (0, 0, 0)
            else:
                ref = await rag_engine.generate_reference_with_context(
                    project_id=conv.project_id,
                    user_question=user_prompt,
                    prior_context=prior_context,
                    guideline_texts=guideline_texts,
                    provider=payload.ai_provider,
                )
                reference_text = ref.answer
                retrieved_chunks = [
                    {"text": c.text, "source": c.source, "score": float(c.score)}
                    for c in ref.retrieved_chunks
                ]
                ref_tokens = (
                    int(getattr(ref, "prompt_tokens", 0) or 0),
                    int(getattr(ref, "completion_tokens", 0) or 0),
                    int(getattr(ref, "total_tokens", 0) or 0),
                )

            ai_result = await ai_engine.judge(
                question=user_prompt,
                response=assistant_message.content,
                reference=reference_text,
                guidelines=guideline_texts,
                provider=payload.ai_provider,
                prior_context=prior_context,
                # CUSTOM_CHECKS_DISABLED — argument intentionally not passed.
                # custom_checks=custom_checks_payload or None,
            )
            return {
                "plan": plan,
                "reference": reference_text,
                "retrieved_chunks": retrieved_chunks,
                "ref_tokens": ref_tokens,
                "ml": None,
                "ai": ai_result,
            }

    try:
        turn_results = await asyncio.gather(*(_run_turn(p) for p in plans))
    except MissingProviderCredentialsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except JudgeParseError as exc:
        raise HTTPException(
            status_code=502, detail=f"AI judge produced unparseable output: {exc}"
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Engine failure: {exc}") from exc

    # Persist
    conv_eval = ConversationEvaluation(
        conversation_id=conversation_id,
        method=payload.method,
        ai_provider=payload.ai_provider,
    )
    session.add(conv_eval)
    session.commit()
    session.refresh(conv_eval)

    out_turns: list[TurnEvaluationOut] = []
    combineds: list[float] = []
    _allowlist_text = ""
    _proj_for_pii = session.get(Project, conv.project_id)
    if _proj_for_pii is not None:
        _allowlist_text = _proj_for_pii.allowed_pii_patterns or ""
    for r in turn_results:
        plan = r["plan"]
        assistant_message: Message = plan["message"]
        ml_result = None
        ai_result = r["ai"]
        ml_combined = None
        ai_combined = float(combine_judge(ai_result)) if ai_result is not None else None
        refusal_mode = False
        combined = ai_combined

        # Hard PII cap: any leak forces a fail (cap combined at 30) regardless
        # of how the LLM judge scored the rest of the response.
        pii_hits = filter_allowed(
            scan_pii(assistant_message.content or ""), _allowlist_text
        )
        if pii_hits:
            combined = 30.0 if combined is None else min(combined, 30.0)

        # Token usage from this turn's AI judge + reference calls.
        j_usage = getattr(ai_result, "usage", None) if ai_result is not None else None
        j_prompt = int(getattr(j_usage, "prompt", 0) or 0) if j_usage else 0
        j_completion = int(getattr(j_usage, "completion", 0) or 0) if j_usage else 0
        j_total = int(getattr(j_usage, "total", 0) or 0) if j_usage else 0
        rp, rc, rt = r.get("ref_tokens") or (0, 0, 0)
        turn = TurnEvaluation(
            conversation_evaluation_id=conv_eval.id,
            message_id=assistant_message.id,
            ml_score=ml_combined,
            ai_score=ai_combined,
            combined_score=combined,
            reference_answer=r["reference"],
            rationale=(ai_result.rationale if ai_result is not None else None),
            judge_prompt_tokens=j_prompt or None,
            judge_completion_tokens=j_completion or None,
            judge_total_tokens=j_total or None,
            reference_prompt_tokens=int(rp) or None,
            reference_completion_tokens=int(rc) or None,
            reference_total_tokens=int(rt) or None,
        )
        session.add(turn)
        session.commit()
        session.refresh(turn)

        metric_rows: list[MetricScore] = []
        if ai_result is not None:
            metric_rows.extend(_ai_metric_rows(ai_result))

        # CUSTOM_CHECKS_DISABLED — per-turn custom-check persistence + response
        # payload disabled. Restore the block below to re-enable.
        custom_check_results_out: list[CustomCheckResultOut] = []
        # if ai_result is not None and custom_check_rows:
        #     for ccr in getattr(ai_result, "custom_check_results", []) or []:
        #         check = custom_check_by_id.get(ccr.id)
        #         weight = float(check.weight) if check else 0.0
        #         metric_rows.append(
        #             MetricScore(
        #                 engine="custom",
        #                 metric_name=f"custom:{ccr.id}",
        #                 value=float(ccr.score),
        #                 weight=weight,
        #             )
        #         )
        #         custom_check_results_out.append(
        #             CustomCheckResultOut(
        #                 id=ccr.id,
        #                 description=(check.description if check else ""),
        #                 score=float(ccr.score),
        #                 passed=bool(ccr.passed),
        #                 reason=ccr.reason,
        #                 weight=weight,
        #             )
        #         )

        for row in metric_rows:
            row.turn_evaluation_id = turn.id
            session.add(row)

        finding_rows: list[GuidelineFinding] = []
        if ai_result is not None:
            for f in ai_result.findings or []:
                fr = GuidelineFinding(
                    turn_evaluation_id=turn.id,
                    guideline_excerpt=getattr(f, "guideline_excerpt", "") or "",
                    offending_span=getattr(f, "offending_span", "") or "",
                    reason=getattr(f, "reason", "") or "",
                    severity=getattr(f, "severity", None),
                )
                session.add(fr)
                finding_rows.append(fr)
        session.commit()

        ml_dims = None
        ai_dims = None
        if ai_result is not None:
            ai_dims = DimensionBreakdown(
                similarity=ai_result.similarity,
                accuracy=ai_result.accuracy,
                completeness=ai_result.completeness,
                relevance=ai_result.relevance,
                readability=getattr(ai_result, "readability", 80.0) or 80.0,
            )

        out_turns.append(
            TurnEvaluationOut(
                id=turn.id,
                message_id=assistant_message.id,
                position=plan["position"],
                user_prompt=plan["user_prompt"],
                assistant_response=assistant_message.content,
                reference_answer=r["reference"],
                ml_score=ml_combined,
                ai_score=ai_combined,
                combined_score=combined,
                rationale=turn.rationale,
                ml_dimensions=ml_dims,
                ai_dimensions=ai_dims,
                ml_metrics=[
                    MetricScoreOut(
                        engine="ml",
                        metric_name=mr.metric_name,
                        value=mr.value,
                        weight=mr.weight,
                    )
                    for mr in metric_rows
                    if mr.engine == "ml"
                ],
                ai_metrics=[
                    MetricScoreOut(
                        engine="ai",
                        metric_name=mr.metric_name,
                        value=mr.value,
                        weight=mr.weight,
                    )
                    for mr in metric_rows
                    if mr.engine == "ai"
                ],
                guideline_findings=[
                    GuidelineFindingOut(
                        guideline_excerpt=f.guideline_excerpt,
                        offending_span=f.offending_span,
                        reason=f.reason,
                        severity=f.severity,
                    )
                    for f in finding_rows
                ],
                retrieved_chunks=r["retrieved_chunks"],
                refusal_mode=refusal_mode,
                pii_hits=[
                    PIIHitOut(kind=h.kind, span=h.span, start=h.start, end=h.end)
                    for h in pii_hits
                ],
                custom_check_results=custom_check_results_out,
                judge_prompt_tokens=turn.judge_prompt_tokens,
                judge_completion_tokens=turn.judge_completion_tokens,
                judge_total_tokens=turn.judge_total_tokens,
                reference_prompt_tokens=turn.reference_prompt_tokens,
                reference_completion_tokens=turn.reference_completion_tokens,
                reference_total_tokens=turn.reference_total_tokens,
            )
        )
        if combined is not None:
            combineds.append(combined)

    summary = ConversationEvaluationSummary(
        average_combined=(sum(combineds) / len(combineds)) if combineds else None,
        min_combined=min(combineds) if combineds else None,
        max_combined=max(combineds) if combineds else None,
        turn_count=len(out_turns),
    )

    return ConversationEvaluationOut(
        id=conv_eval.id,
        conversation_id=conv_eval.conversation_id,
        method=payload.method,
        ai_provider=conv_eval.ai_provider,
        created_at=conv_eval.created_at,
        turn_evaluations=out_turns,
        summary=summary,
    )
