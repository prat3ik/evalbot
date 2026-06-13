from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from ..db import get_session
from ..engines import ai as ai_engine
from ..engines.pii import filter_allowed, scan_pii
from ..engines.judges import (
    JudgeParseError,
    JudgeTimeoutError,
    MissingProviderCredentialsError,
)
from ..engines.rag import UnsupportedDocumentError
# CUSTOM_CHECKS_DISABLED — CustomCheck import removed; restore to re-enable.
from ..models import Evaluation, GuidelineFinding, MetricScore, Project
from ..scoring import (
    DEFAULT_WEIGHTS,
    combine_judge,
)
from ..services.reference import get_or_create_reference, load_guideline_texts

router = APIRouter()


EvaluationMethod = Literal["ml", "ai", "both"]


class EvaluateRequest(BaseModel):
    project_id: str
    question: str
    chatbot_response: str
    reference_answer: str | None = None
    method: EvaluationMethod = "both"
    ai_provider: str | None = None
    ai_model: str | None = None
    weights: dict[str, float] = Field(default_factory=lambda: dict(DEFAULT_WEIGHTS))


class MetricScoreOut(BaseModel):
    engine: Literal["ml", "ai"]
    metric_name: str
    value: float
    weight: float = 0.0


class GuidelineFindingOut(BaseModel):
    guideline_excerpt: str
    offending_span: str
    reason: str
    severity: str | None = None


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


class EvaluateResponse(BaseModel):
    id: str
    project_id: str
    question: str
    chatbot_response: str
    reference_answer: str
    method: EvaluationMethod
    ai_provider: str | None = None

    ml_score: float | None = None
    ai_score: float | None = None
    combined_score: float | None = None

    # Token usage (nullable; older clients ignore these fields)
    judge_prompt_tokens: int | None = None
    judge_completion_tokens: int | None = None
    judge_total_tokens: int | None = None
    reference_prompt_tokens: int | None = None
    reference_completion_tokens: int | None = None
    reference_total_tokens: int | None = None
    chatbot_prompt_tokens: int | None = None
    chatbot_completion_tokens: int | None = None
    chatbot_total_tokens: int | None = None

    ml_dimensions: DimensionBreakdown | None = None
    ai_dimensions: DimensionBreakdown | None = None

    ml_metrics: list[MetricScoreOut] = []
    ai_metrics: list[MetricScoreOut] = []
    guideline_findings: list[GuidelineFindingOut] = []
    retrieved_chunks: list[dict] = []
    rationale: str | None = None
    created_at: datetime | None = None
    refusal_mode: bool = False
    pii_hits: list[PIIHitOut] = []
    custom_check_results: list[CustomCheckResultOut] = []
    # When this evaluation was produced as part of a dataset run, surface the
    # back-reference so the detail page can link back. Always null for ad-hoc
    # single-turn / multi-turn evaluations.
    dataset_run_id: str | None = None
    dataset_run_name: str | None = None
    dataset_id: str | None = None
    dataset_name: str | None = None
    # Source dataset row id (only set when this evaluation came from a dataset
    # run). The detail page uses it to surface a "View dataset row" link.
    dataset_row_id: str | None = None
    # Multi-turn conversation transcript for the source row, if any. Empty
    # list means single-turn (use `question` directly). Each turn is
    # {"role": "user"|"assistant"|"system", "content": str}.
    turns: list[dict] = []
    # Manual reviewer override fields.
    override_verdict: str | None = None
    override_note: str | None = None
    override_author: str | None = None
    override_created_at: str | None = None


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
                evaluation_id="",
                engine="ai",
                metric_name=d,
                value=float(getattr(jr, d, 0.0) or 0.0),
                weight=float(DEFAULT_WEIGHTS.get(d, 0.0)),
            )
        )
    return rows


def _to_metric_out(rows: list[MetricScore], engine: str) -> list[MetricScoreOut]:
    return [
        MetricScoreOut(
            engine=engine,  # type: ignore[arg-type]
            metric_name=r.metric_name,
            value=r.value,
            weight=r.weight,
        )
        for r in rows
        if r.engine == engine
    ]


async def run_evaluation_core(
    session: Session,
    project_id: str,
    question: str,
    chatbot_response: str,
    method: EvaluationMethod = "both",
    ai_provider: str | None = None,
    reference_answer: str | None = None,
    run_type: str = "single",
    chatbot_tokens: tuple[int, int, int] | None = None,
) -> EvaluateResponse:
    """Shared core that powers both POST /evaluate and the dataset batch worker.

    Raises HTTPException on failure modes so the API endpoint can re-raise
    directly; callers running outside an HTTP request (the dataset worker)
    should catch HTTPException and persist `.detail` to the run-item.

    ``run_type`` tags the persisted Evaluation row so the Activity tab can
    classify it. Use ``"dataset"`` from the dataset worker, ``"scheduled"``
    from the scheduler, and the default ``"single"`` for ad-hoc evaluations.
    """
    payload = EvaluateRequest(
        project_id=project_id,
        question=question,
        chatbot_response=chatbot_response,
        reference_answer=reference_answer,
        method=method,
        ai_provider=ai_provider,
    )
    return await _evaluate_impl(
        payload, session, run_type=run_type, chatbot_tokens=chatbot_tokens
    )


@router.post("/evaluate", response_model=EvaluateResponse)
async def evaluate(
    payload: EvaluateRequest,
    session: Session = Depends(get_session),
) -> EvaluateResponse:
    return await _evaluate_impl(payload, session)


async def _evaluate_impl(
    payload: EvaluateRequest,
    session: Session,
    *,
    run_type: str = "single",
    chatbot_tokens: tuple[int, int, int] | None = None,
) -> EvaluateResponse:
    project = session.get(Project, payload.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question must be non-empty")
    if not payload.chatbot_response.strip():
        raise HTTPException(status_code=400, detail="chatbot_response must be non-empty")
    # Method is retained on the request for backward compatibility, but the
    # ML/NLP engine has been removed — only the AI judge runs.

    # --- Reference answer (cached or freshly generated) ---------------------
    retrieved_chunks: list[dict] = []
    reference_text: str
    # Reference token usage. Populated only on a fresh generation; cache reuse
    # contributes 0 tokens to THIS evaluation (the originating evaluation
    # already accounted for those tokens).
    ref_prompt_tokens = 0
    ref_completion_tokens = 0
    ref_total_tokens = 0
    needs_reference = payload.reference_answer is None or not payload.reference_answer.strip()
    if needs_reference:
        try:
            ref = await get_or_create_reference(
                session=session,
                project_id=payload.project_id,
                question=question,
                provider=payload.ai_provider,
            )
        except MissingProviderCredentialsError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except UnsupportedDocumentError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=500, detail=f"Reference generation failed: {exc}"
            ) from exc
        reference_text = ref.row.answer
        retrieved_chunks = ref.retrieved_chunks
        if not ref.cached:
            ref_prompt_tokens = int(ref.prompt_tokens or 0)
            ref_completion_tokens = int(ref.completion_tokens or 0)
            ref_total_tokens = int(ref.total_tokens or 0)
    else:
        reference_text = payload.reference_answer

    guideline_texts = load_guideline_texts(session, payload.project_id)

    # CUSTOM_CHECKS_DISABLED — loading + passing custom checks is disabled.
    # Restore the block below to re-enable.
    # from sqlmodel import select as _select  # local import to avoid top churn
    #
    # custom_check_rows = list(
    #     session.exec(
    #         _select(CustomCheck)
    #         .where(CustomCheck.project_id == payload.project_id)
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

    # --- Run AI judge --------------------------------------------------------
    ml_result = None
    try:
        ai_result = await ai_engine.judge(
            question=question,
            response=payload.chatbot_response,
            reference=reference_text,
            guidelines=guideline_texts,
            provider=payload.ai_provider,
            # CUSTOM_CHECKS_DISABLED — argument intentionally not passed.
            # custom_checks=custom_checks_payload or None,
        )
    except MissingProviderCredentialsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except JudgeTimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail=f"AI judge timed out: {exc}. Try again or switch provider.",
        ) from exc
    except JudgeParseError as exc:
        raise HTTPException(
            status_code=502, detail=f"AI judge produced unparseable output: {exc}"
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Engine failure: {exc}") from exc

    ml_combined: float | None = None
    ai_combined: float | None = None
    if ai_result is not None:
        ai_combined = float(combine_judge(ai_result))

    refusal_mode = False
    combined = ai_combined

    # --- PII scan ------------------------------------------------------------
    # Deterministic rule: any leaked PII forces a hard failure. We cap the
    # combined score at 30 so the evaluation visibly fails even when the LLM
    # judge thought the answer was otherwise excellent. Caps (rather than
    # zero-outs) so dimension scores still tell the operator *what else* the
    # response did well — they just can't ship it.
    pii_hits = scan_pii(payload.chatbot_response)
    _project_for_pii = session.get(Project, payload.project_id)
    pii_hits = filter_allowed(
        pii_hits,
        _project_for_pii.allowed_pii_patterns if _project_for_pii else "",
    )
    if pii_hits and combined is not None:
        combined = min(combined, 30.0)
    elif pii_hits and combined is None:
        combined = 30.0

    # --- Persist Evaluation row + metrics + findings -------------------------
    # Single transaction: stage parent + all children, then ONE commit. On any
    # failure we roll back so history never shows an Evaluation row with no
    # metrics or findings.
    # Extract token usage from the AI judge result (if AI ran)
    j_prompt = j_completion = j_total = 0
    if ai_result is not None:
        usage = getattr(ai_result, "usage", None)
        if usage is not None:
            j_prompt = int(getattr(usage, "prompt", 0) or 0)
            j_completion = int(getattr(usage, "completion", 0) or 0)
            j_total = int(getattr(usage, "total", 0) or 0)

    cb_prompt, cb_completion, cb_total = (chatbot_tokens or (0, 0, 0))

    evaluation = Evaluation(
        project_id=payload.project_id,
        question=question,
        chatbot_response=payload.chatbot_response,
        reference_answer=reference_text,
        method=payload.method,
        ai_provider=payload.ai_provider,
        ml_score=ml_combined,
        ai_score=ai_combined,
        combined_score=combined,
        rationale=(ai_result.rationale if ai_result is not None else None),
        run_type=run_type or "single",
        judge_prompt_tokens=j_prompt or None,
        judge_completion_tokens=j_completion or None,
        judge_total_tokens=j_total or None,
        reference_prompt_tokens=ref_prompt_tokens or None,
        reference_completion_tokens=ref_completion_tokens or None,
        reference_total_tokens=ref_total_tokens or None,
        chatbot_prompt_tokens=int(cb_prompt) or None,
        chatbot_completion_tokens=int(cb_completion) or None,
        chatbot_total_tokens=int(cb_total) or None,
    )

    metric_rows: list[MetricScore] = []
    if ai_result is not None:
        metric_rows.extend(_ai_metric_rows(ai_result))

    # CUSTOM_CHECKS_DISABLED — persistence of per-check MetricScore rows +
    # response payload disabled. Restore the block below to re-enable.
    custom_check_results_out: list[CustomCheckResultOut] = []
    # if ai_result is not None and custom_check_rows:
    #     for ccr in getattr(ai_result, "custom_check_results", []) or []:
    #         check = custom_check_by_id.get(ccr.id)
    #         weight = float(check.weight) if check else 0.0
    #         metric_rows.append(
    #             MetricScore(
    #                 evaluation_id="",
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

    finding_rows: list[GuidelineFinding] = []
    if ai_result is not None:
        for f in ai_result.findings or []:
            finding_rows.append(
                GuidelineFinding(
                    evaluation_id=evaluation.id,
                    guideline_excerpt=getattr(f, "guideline_excerpt", "") or "",
                    offending_span=getattr(f, "offending_span", "") or "",
                    reason=getattr(f, "reason", "") or "",
                    severity=getattr(f, "severity", None),
                )
            )

    try:
        session.add(evaluation)
        for row in metric_rows:
            row.evaluation_id = evaluation.id
            session.add(row)
        for fr in finding_rows:
            session.add(fr)
        session.commit()
        session.refresh(evaluation)
    except Exception as exc:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Persistence failed: {exc}") from exc

    # --- Build response ------------------------------------------------------
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

    return EvaluateResponse(
        id=evaluation.id,
        project_id=evaluation.project_id,
        question=evaluation.question,
        chatbot_response=evaluation.chatbot_response,
        reference_answer=evaluation.reference_answer,
        method=payload.method,
        ai_provider=evaluation.ai_provider,
        ml_score=ml_combined,
        ai_score=ai_combined,
        combined_score=combined,
        judge_prompt_tokens=evaluation.judge_prompt_tokens,
        judge_completion_tokens=evaluation.judge_completion_tokens,
        judge_total_tokens=evaluation.judge_total_tokens,
        reference_prompt_tokens=evaluation.reference_prompt_tokens,
        reference_completion_tokens=evaluation.reference_completion_tokens,
        reference_total_tokens=evaluation.reference_total_tokens,
        chatbot_prompt_tokens=evaluation.chatbot_prompt_tokens,
        chatbot_completion_tokens=evaluation.chatbot_completion_tokens,
        chatbot_total_tokens=evaluation.chatbot_total_tokens,
        ml_dimensions=ml_dims,
        ai_dimensions=ai_dims,
        ml_metrics=_to_metric_out(metric_rows, "ml"),
        ai_metrics=_to_metric_out(metric_rows, "ai"),
        guideline_findings=[
            GuidelineFindingOut(
                guideline_excerpt=f.guideline_excerpt,
                offending_span=f.offending_span,
                reason=f.reason,
                severity=f.severity,
            )
            for f in finding_rows
        ],
        retrieved_chunks=retrieved_chunks,
        rationale=(ai_result.rationale if ai_result is not None else None),
        created_at=evaluation.created_at,
        refusal_mode=refusal_mode,
        pii_hits=[
            PIIHitOut(kind=h.kind, span=h.span, start=h.start, end=h.end)
            for h in pii_hits
        ],
        custom_check_results=custom_check_results_out,
    )
