from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlmodel import Session, or_, select

from ..config import settings
from ..db import get_session
from ..models import Question

router = APIRouter()
logger = logging.getLogger(__name__)


class QuestionRead(BaseModel):
    id: str | None = None
    category: str
    text: str
    project_id: str | None = None
    expected_behavior: str | None = None
    is_seed: bool = True


class QuestionCreate(BaseModel):
    text: str
    category: str
    project_id: str | None = None
    expected_behavior: str | None = None


def _load_seed_questions() -> list[QuestionRead]:
    seed_file = settings.seed_path / "questions.json"
    if not seed_file.exists():
        logger.warning("Seed questions file not found at %s", seed_file)
        return []

    try:
        raw = json.loads(seed_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to read seed questions file %s: %s", seed_file, exc)
        return []

    if not isinstance(raw, list):
        logger.warning(
            "Seed questions file %s is malformed (expected list at top level)",
            seed_file,
        )
        return []

    items: list[QuestionRead] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        try:
            items.append(QuestionRead(**entry, is_seed=True))
        except Exception as exc:
            logger.warning("Skipping malformed seed question entry: %s", exc)
            continue
    return items


@router.get("/questions", response_model=list[QuestionRead])
def list_questions(
    category: str | None = Query(default=None),
    project_id: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> list[QuestionRead]:
    seeds = _load_seed_questions()

    # Custom questions from DB. If a project_id filter is given, return that
    # project's custom questions plus globally-scoped (project_id IS NULL)
    # custom questions; otherwise return all custom questions.
    stmt = select(Question).where(Question.is_seed == False)  # noqa: E712
    if project_id is not None:
        stmt = stmt.where(or_(Question.project_id == project_id, Question.project_id.is_(None)))
    custom_rows = session.exec(stmt).all()
    customs = [
        QuestionRead(
            id=q.id,
            category=q.category,
            text=q.text,
            project_id=q.project_id,
            expected_behavior=q.expected_behavior,
            is_seed=False,
        )
        for q in custom_rows
    ]

    combined = seeds + customs
    if category:
        combined = [q for q in combined if q.category == category]
    return combined


@router.post("/questions", response_model=QuestionRead, status_code=201)
def create_question(
    payload: QuestionCreate,
    session: Session = Depends(get_session),
) -> QuestionRead:
    q = Question(
        text=payload.text,
        category=payload.category,
        project_id=payload.project_id,
        expected_behavior=payload.expected_behavior,
        is_seed=False,
    )
    session.add(q)
    session.commit()
    session.refresh(q)
    return QuestionRead(
        id=q.id,
        category=q.category,
        text=q.text,
        project_id=q.project_id,
        expected_behavior=q.expected_behavior,
        is_seed=False,
    )
