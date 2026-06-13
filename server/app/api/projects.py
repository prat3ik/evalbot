from __future__ import annotations

import contextlib
import shutil
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..config import settings
from ..db import get_session
from ..engines.rag import delete_project_collection
from ..models import (
    Conversation,
    ConversationEvaluation,
    Dataset,
    DatasetRow,
    DatasetRun,
    DatasetRunItem,
    DatasetSchedule,
    Document,
    Evaluation,
    GuidelineFile,
    GuidelineFinding,
    Message,
    MetricScore,
    Project,
    Question,
    ReferenceAnswer,
    TurnEvaluation,
)

router = APIRouter()


class ProjectCreate(BaseModel):
    name: str
    description: str | None = None


class ProjectRead(BaseModel):
    id: str
    name: str
    description: str | None
    created_at: datetime
    chatbot_endpoint: str | None = None
    chatbot_request_template: str | None = None
    chatbot_response_path: str | None = None
    allowed_pii_patterns: str = ""


@router.post("/projects", response_model=ProjectRead, status_code=201)
def create_project(
    payload: ProjectCreate,
    session: Session = Depends(get_session),
) -> ProjectRead:
    project = Project(name=payload.name, description=payload.description)
    session.add(project)
    session.commit()
    session.refresh(project)

    # Create on-disk layout for this project's docs + guidelines.
    project_dir = settings.projects_path / project.id
    (project_dir / "docs").mkdir(parents=True, exist_ok=True)
    (project_dir / "guidelines").mkdir(parents=True, exist_ok=True)

    return ProjectRead(**project.model_dump())


@router.get("/projects", response_model=list[ProjectRead])
def list_projects(session: Session = Depends(get_session)) -> list[ProjectRead]:
    rows = session.exec(select(Project).order_by(Project.created_at.desc())).all()
    return [ProjectRead(**p.model_dump()) for p in rows]


@router.get("/projects/{project_id}", response_model=ProjectRead)
def get_project(
    project_id: str,
    session: Session = Depends(get_session),
) -> ProjectRead:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return ProjectRead(**project.model_dump())


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    chatbot_endpoint: str | None = None
    chatbot_request_template: str | None = None
    chatbot_response_path: str | None = None
    allowed_pii_patterns: str | None = None


@router.patch("/projects/{project_id}", response_model=ProjectRead)
def update_project(
    project_id: str,
    payload: ProjectUpdate,
    session: Session = Depends(get_session),
) -> ProjectRead:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        project.name = name
    if payload.description is not None:
        project.description = payload.description
    if payload.chatbot_endpoint is not None:
        project.chatbot_endpoint = payload.chatbot_endpoint or None
    if payload.chatbot_request_template is not None:
        project.chatbot_request_template = payload.chatbot_request_template or None
    if payload.chatbot_response_path is not None:
        project.chatbot_response_path = payload.chatbot_response_path or None
    if payload.allowed_pii_patterns is not None:
        project.allowed_pii_patterns = payload.allowed_pii_patterns or ""
    session.add(project)
    session.commit()
    session.refresh(project)
    return ProjectRead(**project.model_dump())


@router.delete("/projects/{project_id}", status_code=204)
async def delete_project(
    project_id: str,
    session: Session = Depends(get_session),
) -> None:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # Drop the vector collection before cascading the DB rows.
    # Best-effort: never block project deletion on vector store cleanup.
    with contextlib.suppress(Exception):
        await delete_project_collection(project_id)

    # Best-effort cleanup of child rows. Delete grandchildren (MetricScore,
    # GuidelineFinding) before their parent Evaluation rows.
    evaluations = session.exec(select(Evaluation).where(Evaluation.project_id == project_id)).all()
    eval_ids = [ev.id for ev in evaluations]
    if eval_ids:
        for ms in session.exec(
            select(MetricScore).where(MetricScore.evaluation_id.in_(eval_ids))
        ).all():
            session.delete(ms)
        for gfinding in session.exec(
            select(GuidelineFinding).where(GuidelineFinding.evaluation_id.in_(eval_ids))
        ).all():
            session.delete(gfinding)
    for ev in evaluations:
        session.delete(ev)

    # Cascade conversations -> messages, conversation_evaluations -> turn_evaluations
    # -> metric_scores + guideline_findings (turn_evaluation_id link).
    conversations = session.exec(
        select(Conversation).where(Conversation.project_id == project_id)
    ).all()
    conv_ids = [c.id for c in conversations]
    if conv_ids:
        conv_evals = session.exec(
            select(ConversationEvaluation).where(
                ConversationEvaluation.conversation_id.in_(conv_ids)
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
        for msg in session.exec(select(Message).where(Message.conversation_id.in_(conv_ids))).all():
            session.delete(msg)
    for conv in conversations:
        session.delete(conv)

    # Cascade datasets -> rows -> runs -> run-items + schedule
    datasets = session.exec(select(Dataset).where(Dataset.project_id == project_id)).all()
    ds_ids = [d.id for d in datasets]
    if ds_ids:
        runs = session.exec(select(DatasetRun).where(DatasetRun.dataset_id.in_(ds_ids))).all()
        run_ids = [r.id for r in runs]
        if run_ids:
            for item in session.exec(
                select(DatasetRunItem).where(DatasetRunItem.dataset_run_id.in_(run_ids))
            ).all():
                session.delete(item)
        for r in runs:
            session.delete(r)
        for row in session.exec(select(DatasetRow).where(DatasetRow.dataset_id.in_(ds_ids))).all():
            session.delete(row)
        for sch in session.exec(
            select(DatasetSchedule).where(DatasetSchedule.dataset_id.in_(ds_ids))
        ).all():
            session.delete(sch)
    for d in datasets:
        session.delete(d)

    for doc in session.exec(select(Document).where(Document.project_id == project_id)).all():
        session.delete(doc)
    for gf in session.exec(
        select(GuidelineFile).where(GuidelineFile.project_id == project_id)
    ).all():
        session.delete(gf)
    for ra in session.exec(
        select(ReferenceAnswer).where(ReferenceAnswer.project_id == project_id)
    ).all():
        session.delete(ra)
    for q in session.exec(select(Question).where(Question.project_id == project_id)).all():
        session.delete(q)

    session.delete(project)
    session.commit()

    project_dir = settings.projects_path / project_id
    if project_dir.exists():
        shutil.rmtree(project_dir, ignore_errors=True)
