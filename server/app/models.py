from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    """Timezone-aware UTC now (replacement for deprecated datetime.utcnow)."""
    return datetime.now(UTC)


class Project(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    name: str
    description: str | None = None
    created_at: datetime = Field(default_factory=_now)
    # DEPRECATED — kept for backward compat only. Use the ChatbotEndpoint table
    # instead. On first boot, populated values here are auto-migrated into a
    # `Default` ChatbotEndpoint row for the project. These columns will be
    # dropped in a future destructive migration; new consumers should write to
    # ChatbotEndpoint via the /api/chatbot-endpoints API.
    chatbot_endpoint: str | None = None
    chatbot_request_template: str | None = None
    chatbot_response_path: str | None = None
    # Newline-separated list of regex patterns / literal strings that should
    # never trigger PII detection. Matched against PIIHit.span — any match
    # filters the hit out before the banner / score cap is applied. Common
    # use: legitimate support emails / domains the bot is allowed to surface.
    allowed_pii_patterns: str = ""


class ChatbotEndpoint(SQLModel, table=True):
    """A named, configurable chatbot endpoint belonging to a project.

    Projects can have N endpoints (e.g. "Lumen v1 prod", "Lumen v2 staging") so
    the same dataset can be evaluated against multiple bot configurations.
    Response and token field paths are configurable per endpoint because each
    deployment may have a different JSON response shape.
    """

    id: str = Field(default_factory=_uuid, primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    name: str
    url: str
    method: str = "POST"
    headers_json: str = "{}"
    request_template: str = '{"question": "{{question}}"}'
    response_path: str = "$.response"
    tokens_prompt_path: str | None = None
    tokens_completion_path: str | None = None
    tokens_total_path: str | None = None
    timeout_seconds: float = 30.0
    is_default: bool = False
    # Last "Test connection" question the user typed for this endpoint —
    # persisted so re-opening the edit dialog restores it.
    test_question: str | None = None
    created_at: datetime = Field(default_factory=_now)


class Document(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    filename: str
    path: str
    indexed_at: datetime | None = None
    # Cached cleaned/distilled markdown for URL-ingested docs — what was
    # actually fed into the chunker. Null for file uploads.
    indexed_text: str | None = None
    # True only when `indexed_text` came from an AI distillation pass
    # (Smart extract). False/Null means the cached text is the raw scrape.
    distilled: bool = False


class GuidelineFile(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    filename: str
    path: str
    content: str = ""
    uploaded_at: datetime = Field(default_factory=_now)


class ReferenceAnswer(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    question_hash: str = Field(index=True)
    question: str
    answer: str
    retrieved_chunks_json: str = "[]"
    created_at: datetime = Field(default_factory=_now)


class Evaluation(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    question: str
    chatbot_response: str
    reference_answer: str
    method: str  # "ml" | "ai" | "both"
    ai_provider: str | None = None
    ml_score: float | None = None
    ai_score: float | None = None
    combined_score: float | None = None
    # Free-form natural-language explanation from the AI judge. Null when the
    # judge wasn't run (method="ml") or when the row predates this column.
    rationale: str | None = None
    # How this evaluation was kicked off. Used by the Activity tab to classify
    # rows (single one-off, batch-from-dataset, scheduled, multi-turn-chat).
    # Multi-turn rows are typically detected via TurnEvaluation joins; this
    # column primarily distinguishes single vs. dataset vs. scheduled.
    run_type: str = Field(default="single")
    # Token usage captured from the underlying LLM calls. All nullable so old
    # rows + non-AI methods don't need backfill. "judge" = the AI judge call,
    # "reference" = the cached reference-generation call (0 on cache reuse),
    # "chatbot" = the dummy/configured chatbot endpoint call (dataset rows).
    judge_prompt_tokens: int | None = None
    judge_completion_tokens: int | None = None
    judge_total_tokens: int | None = None
    reference_prompt_tokens: int | None = None
    reference_completion_tokens: int | None = None
    reference_total_tokens: int | None = None
    chatbot_prompt_tokens: int | None = None
    chatbot_completion_tokens: int | None = None
    chatbot_total_tokens: int | None = None
    # Manual reviewer override. When override_verdict is "pass" or "fail",
    # it takes precedence over combined_score >= 75 for pass-rate / regression /
    # cluster aggregation. null = no override applied.
    override_verdict: str | None = None
    override_note: str | None = None
    override_author: str | None = None
    override_created_at: str | None = None
    created_at: datetime = Field(default_factory=_now)


class MetricScore(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    evaluation_id: str | None = Field(default=None, foreign_key="evaluation.id", index=True)
    turn_evaluation_id: str | None = Field(
        default=None, foreign_key="turnevaluation.id", index=True
    )
    engine: str  # "ml" | "ai"
    metric_name: str
    value: float
    weight: float = 0.0


class GuidelineFinding(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    evaluation_id: str | None = Field(default=None, foreign_key="evaluation.id", index=True)
    turn_evaluation_id: str | None = Field(
        default=None, foreign_key="turnevaluation.id", index=True
    )
    guideline_excerpt: str
    offending_span: str
    reason: str
    severity: str | None = None  # minor | major | critical


class Conversation(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    title: str
    created_at: datetime = Field(default_factory=_now)


class Message(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    conversation_id: str = Field(foreign_key="conversation.id", index=True)
    position: int
    role: str  # "system" | "user" | "assistant" | "tool"
    content: str = ""
    tool_calls_json: str | None = None
    tool_call_id: str | None = None
    # Optional user-supplied "what the bot should have said" override for
    # assistant turns. When set on an assistant message, conversation
    # evaluation uses it as the reference answer instead of generating one
    # from RAG. Ignored on non-assistant roles.
    expected_response: str | None = None
    created_at: datetime = Field(default_factory=_now)


class ConversationEvaluation(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    conversation_id: str = Field(foreign_key="conversation.id", index=True)
    method: str
    ai_provider: str | None = None
    created_at: datetime = Field(default_factory=_now)


class TurnEvaluation(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    conversation_evaluation_id: str = Field(foreign_key="conversationevaluation.id", index=True)
    message_id: str = Field(foreign_key="message.id", index=True)
    ml_score: float | None = None
    ai_score: float | None = None
    combined_score: float | None = None
    reference_answer: str = ""
    rationale: str | None = None
    judge_prompt_tokens: int | None = None
    judge_completion_tokens: int | None = None
    judge_total_tokens: int | None = None
    reference_prompt_tokens: int | None = None
    reference_completion_tokens: int | None = None
    reference_total_tokens: int | None = None
    chatbot_prompt_tokens: int | None = None
    chatbot_completion_tokens: int | None = None
    chatbot_total_tokens: int | None = None
    created_at: datetime = Field(default_factory=_now)


class Dataset(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    name: str
    description: str | None = None
    created_at: datetime = Field(default_factory=_now)


class DatasetRow(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    dataset_id: str = Field(foreign_key="dataset.id", index=True)
    position: int = 0
    question: str
    expected_response: str | None = None
    chatbot_response: str | None = None
    tags_json: str = "[]"
    category: str | None = None
    # How this row's chatbot_response should be sourced when the dataset runs.
    # Values: "manual" (use the stored chatbot_response text), "endpoint:<id>"
    # (POST the question to that ChatbotEndpoint at run time and use the parsed
    # response), or NULL (defer to the run's default endpoint / fall back to
    # the stored manual text if no endpoint is configured).
    chatbot_source: str | None = None
    # Multi-turn transcript: JSON-encoded list of {role, content} dicts.
    # Empty list "[]" means this is a legacy single-turn row. When non-empty,
    # `question` is treated as the last user turn (the latest message the bot
    # is expected to respond to) and the prior turns are kept as context.
    turns_json: str = "[]"


class DatasetRun(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    dataset_id: str = Field(foreign_key="dataset.id", index=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    # Optional human-readable label set when the user kicks off the run
    # (e.g. "Smoke v3 — after auth rewrite"). Used in lists and on the
    # evaluation detail page to point back at the source run.
    name: str | None = None
    method: str  # "ml" | "ai" | "both"
    ai_provider: str | None = None
    tag_filter_json: str = "[]"
    status: str = "pending"  # pending | running | completed | failed | cancelled
    started_at: datetime = Field(default_factory=_now)
    finished_at: datetime | None = None
    total_rows: int = 0
    completed_rows: int = 0
    error: str | None = None
    # Which ChatbotEndpoint this run used (None = manual responses only).
    chatbot_endpoint_id: str | None = Field(
        default=None, foreign_key="chatbotendpoint.id", index=True
    )


class DatasetRunItem(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    dataset_run_id: str = Field(foreign_key="datasetrun.id", index=True)
    dataset_row_id: str = Field(foreign_key="datasetrow.id")
    evaluation_id: str | None = Field(default=None, foreign_key="evaluation.id")
    error: str | None = None
    judge_prompt_tokens: int | None = None
    judge_completion_tokens: int | None = None
    judge_total_tokens: int | None = None
    reference_prompt_tokens: int | None = None
    reference_completion_tokens: int | None = None
    reference_total_tokens: int | None = None
    chatbot_prompt_tokens: int | None = None
    chatbot_completion_tokens: int | None = None
    chatbot_total_tokens: int | None = None


class DatasetSchedule(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    dataset_id: str = Field(foreign_key="dataset.id", index=True, unique=True)
    cron: str | None = None
    enabled: bool = False
    created_at: datetime = Field(default_factory=_now)


# CUSTOM_CHECKS_DISABLED — uncomment the class below to re-enable.
# class CustomCheck(SQLModel, table=True):
#     """A plain-English custom check appended to the AI judge prompt.
#
#     Each project can define N checks. The judge is asked to evaluate the
#     chatbot response against EACH check and return a per-check score, pass
#     flag, and short reason. ``weight=0`` keeps the check informational (it
#     does not factor into the combined score); positive weights make it
#     contribute proportionally alongside the standard AI dimensions.
#     """
#
#     id: str = Field(default_factory=_uuid, primary_key=True)
#     project_id: str = Field(foreign_key="project.id", index=True)
#     description: str
#     weight: float = 0.0
#     created_at: datetime = Field(default_factory=_now)


class Question(SQLModel, table=True):
    id: str = Field(default_factory=_uuid, primary_key=True)
    category: str
    text: str
    project_id: str | None = Field(default=None, foreign_key="project.id", index=True)
    expected_behavior: str | None = None
    is_seed: bool = False
    created_at: datetime = Field(default_factory=_now)
