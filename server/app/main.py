from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import (
    analytics,
    chatbot_endpoints,
    conversations,
    custom_checks,
    datasets,
    documents,
    dummy_chatbot,
    evaluate,
    evaluations,
    guidelines,
    projects,
    question_gen,
    questions,
    reference,
)
from .config import settings
from .db import engine, init_db
from sqlalchemy import text

logger = logging.getLogger(__name__)


def _apply_lightweight_migrations() -> None:
    """Add columns introduced after the initial schema landed.

    SQLite is fine with `ADD COLUMN`; we check existence first so this is
    idempotent and safe to run on every boot. This avoids forcing users to
    delete their local DB every time a column lands.
    """
    token_cols: list[tuple[str, str]] = [
        ("judge_prompt_tokens", "INTEGER"),
        ("judge_completion_tokens", "INTEGER"),
        ("judge_total_tokens", "INTEGER"),
        ("reference_prompt_tokens", "INTEGER"),
        ("reference_completion_tokens", "INTEGER"),
        ("reference_total_tokens", "INTEGER"),
        ("chatbot_prompt_tokens", "INTEGER"),
        ("chatbot_completion_tokens", "INTEGER"),
        ("chatbot_total_tokens", "INTEGER"),
    ]
    additions: dict[str, list[tuple[str, str]]] = {
        "project": [
            ("chatbot_endpoint", "VARCHAR"),
            ("chatbot_request_template", "TEXT"),
            ("chatbot_response_path", "VARCHAR"),
            ("allowed_pii_patterns", "TEXT DEFAULT ''"),
        ],
        "evaluation": [
            ("run_type", "VARCHAR DEFAULT 'single'"),
            ("rationale", "TEXT"),
            *token_cols,
            ("override_verdict", "TEXT"),
            ("override_note", "TEXT"),
            ("override_author", "TEXT"),
            ("override_created_at", "TEXT"),
        ],
        "turnevaluation": [("rationale", "TEXT"), *token_cols],
        "datasetrunitem": list(token_cols),
        "datasetrun": [
            ("chatbot_endpoint_id", "VARCHAR"),
            ("name", "VARCHAR"),
        ],
        "document": [
            ("indexed_text", "TEXT"),
            ("distilled", "BOOLEAN DEFAULT 0"),
        ],
        "datasetrow": [
            ("chatbot_source", "VARCHAR"),
            ("turns_json", "TEXT DEFAULT '[]'"),
        ],
        "chatbotendpoint": [("test_question", "TEXT")],
        "message": [("expected_response", "TEXT")],
    }
    with engine.begin() as conn:
        for table, cols in additions.items():
            existing = {
                row[1]
                for row in conn.execute(text(f"PRAGMA table_info({table})")).all()
            }
            if not existing:
                # Table not created yet (init_db runs first, so this shouldn't
                # happen — but skip defensively).
                continue
            for col_name, col_type in cols:
                if col_name not in existing:
                    conn.execute(
                        text(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}")
                    )
                    logger.info("Migrated: added %s.%s", table, col_name)


def _migrate_legacy_chatbot_endpoints() -> None:
    """One-shot: backfill ChatbotEndpoint rows from legacy Project columns.

    Runs every boot but is idempotent — only acts on projects that have legacy
    ``chatbot_endpoint`` set AND zero ChatbotEndpoint rows. Creates a single
    `Default` row with ``is_default=True``.
    """
    from sqlmodel import Session, select

    from .models import ChatbotEndpoint, Project

    with Session(engine) as session:
        projects = session.exec(select(Project)).all()
        migrated = 0
        for project in projects:
            legacy_url = (project.chatbot_endpoint or "").strip()
            if not legacy_url:
                continue
            existing = session.exec(
                select(ChatbotEndpoint).where(ChatbotEndpoint.project_id == project.id)
            ).first()
            if existing is not None:
                continue
            session.add(
                ChatbotEndpoint(
                    project_id=project.id,
                    name="Default",
                    url=legacy_url,
                    method="POST",
                    headers_json="{}",
                    request_template=(
                        project.chatbot_request_template or '{"question": "{{question}}"}'
                    ),
                    response_path=project.chatbot_response_path or "$.response",
                    tokens_prompt_path="$.tokens.prompt",
                    tokens_completion_path="$.tokens.completion",
                    tokens_total_path="$.tokens.total",
                    is_default=True,
                )
            )
            migrated += 1
        if migrated:
            session.commit()
            logger.info(
                "Migrated %d legacy chatbot_endpoint config(s) to ChatbotEndpoint rows.",
                migrated,
            )


def _migrate_conversations_to_dataset_rows() -> None:
    """One-shot: copy each project's Conversations into an "Imported chats" dataset.

    Conversations are no longer first-class — multi-turn chats now live as
    rows in datasets. Existing Conversation rows are imported per project so
    nothing is lost when the rail goes away. Idempotent: only acts on
    conversations whose title doesn't already carry the imported sentinel.
    """
    import json as _json

    from sqlmodel import Session, select

    from .models import Conversation, Dataset, DatasetRow, Message, Project

    IMPORTED_TITLE_PREFIX = "[imported] "
    IMPORTED_DATASET_NAME = "Imported chats"

    with Session(engine) as session:
        projects = session.exec(select(Project)).all()
        imported_total = 0
        for project in projects:
            convs = session.exec(
                select(Conversation).where(Conversation.project_id == project.id)
            ).all()
            convs = [c for c in convs if not c.title.startswith(IMPORTED_TITLE_PREFIX)]
            if not convs:
                continue
            ds = session.exec(
                select(Dataset)
                .where(Dataset.project_id == project.id)
                .where(Dataset.name == IMPORTED_DATASET_NAME)
            ).first()
            if ds is None:
                ds = Dataset(
                    project_id=project.id,
                    name=IMPORTED_DATASET_NAME,
                    description=(
                        "Multi-turn chats migrated from the old Conversations rail. "
                        "Edit / run them like any other dataset row."
                    ),
                )
                session.add(ds)
                session.commit()
                session.refresh(ds)
            # Highest existing position so imports append below any manual rows.
            max_pos = -1
            for r in session.exec(
                select(DatasetRow).where(DatasetRow.dataset_id == ds.id)
            ).all():
                if r.position > max_pos:
                    max_pos = r.position
            for conv in convs:
                msgs = session.exec(
                    select(Message)
                    .where(Message.conversation_id == conv.id)
                    .order_by(Message.position)
                ).all()
                turns: list[dict[str, str]] = []
                for m in msgs:
                    if m.role in ("user", "assistant") and m.content.strip():
                        turns.append({"role": m.role, "content": m.content})
                if not turns:
                    continue
                last_user = ""
                for t in reversed(turns):
                    if t["role"] == "user":
                        last_user = t["content"]
                        break
                if not last_user:
                    last_user = turns[-1]["content"][:200]
                max_pos += 1
                session.add(
                    DatasetRow(
                        dataset_id=ds.id,
                        position=max_pos,
                        question=last_user,
                        expected_response=None,
                        chatbot_response=None,
                        tags_json=_json.dumps(["imported", "multi-turn"]),
                        category=None,
                        chatbot_source=None,
                        turns_json=_json.dumps(turns),
                    )
                )
                # Mark the original so we never re-import it.
                conv.title = IMPORTED_TITLE_PREFIX + conv.title
                session.add(conv)
                imported_total += 1
            session.commit()
        if imported_total:
            logger.info(
                "Migrated %d conversation(s) into 'Imported chats' dataset row(s).",
                imported_total,
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure data directories exist.
    settings.data_path.mkdir(parents=True, exist_ok=True)
    settings.projects_path.mkdir(parents=True, exist_ok=True)
    settings.chroma_path.mkdir(parents=True, exist_ok=True)

    # Initialise SQLite tables.
    init_db()

    # Apply additive column migrations for older local DBs.
    try:
        _apply_lightweight_migrations()
    except Exception as exc:  # pragma: no cover - log + continue
        logger.warning("Lightweight migration step failed: %s", exc)

    # Backfill ChatbotEndpoint rows from legacy Project columns once.
    try:
        _migrate_legacy_chatbot_endpoints()
    except Exception as exc:  # pragma: no cover - log + continue
        logger.warning("Legacy chatbot endpoint migration failed: %s", exc)

    # Move legacy Conversations into multi-turn dataset rows so nothing is
    # lost when the conversations rail is removed from the UI.
    try:
        _migrate_conversations_to_dataset_rows()
    except Exception as exc:  # pragma: no cover - log + continue
        logger.warning("Conversation → dataset migration failed: %s", exc)

    # Seed the demo "Sample Support Bot" project on first boot so first-time
    # users see a populated app. Idempotent (queried by name); failures here
    # are logged and swallowed so they never block boot.
    if not settings.SEED_PROJECT_DISABLED:
        try:
            from .seed_data import seed_sample_project

            await seed_sample_project()
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Seed sample project step failed: %s", exc)

    yield


app = FastAPI(title="EvalBot API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(projects.router, prefix="/api", tags=["projects"])
app.include_router(documents.router, prefix="/api", tags=["documents"])
app.include_router(guidelines.router, prefix="/api", tags=["guidelines"])
app.include_router(reference.router, prefix="/api", tags=["reference"])
app.include_router(evaluate.router, prefix="/api", tags=["evaluate"])
app.include_router(evaluations.router, prefix="/api", tags=["evaluations"])
app.include_router(questions.router, prefix="/api", tags=["questions"])
app.include_router(analytics.router, prefix="/api", tags=["analytics"])
app.include_router(conversations.router, prefix="/api", tags=["conversations"])
app.include_router(datasets.router, prefix="/api", tags=["datasets"])
app.include_router(dummy_chatbot.router, prefix="/api", tags=["dummy-chatbot"])
app.include_router(chatbot_endpoints.router, prefix="/api", tags=["chatbot-endpoints"])
# CUSTOM_CHECKS_DISABLED — router is an empty stub; include is a no-op.
app.include_router(custom_checks.router, prefix="/api", tags=["custom-checks"])
app.include_router(question_gen.router, prefix="/api", tags=["question-gen"])
