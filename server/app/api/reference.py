from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from ..db import get_session
from ..engines.judges import MissingProviderCredentialsError
from ..engines.rag import UnsupportedDocumentError
from ..models import Project
from ..services.reference import get_or_create_reference

router = APIRouter()


class ReferenceRequest(BaseModel):
    question: str
    ai_provider: str | None = None
    provider: str | None = None  # alias accepted
    force_regenerate: bool = False


class RetrievedChunk(BaseModel):
    document_id: str | None = None
    filename: str | None = None
    text: str
    source: str | None = None
    score: float | None = None


class ReferenceResponse(BaseModel):
    project_id: str
    question: str
    answer: str
    retrieved_chunks: list[RetrievedChunk] = []
    cached: bool = False
    created_at: datetime | None = None


@router.post("/projects/{project_id}/reference", response_model=ReferenceResponse)
async def generate_reference(
    project_id: str,
    payload: ReferenceRequest,
    session: Session = Depends(get_session),
) -> ReferenceResponse:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question must be non-empty")

    provider = payload.ai_provider or payload.provider

    try:
        ref = await get_or_create_reference(
            session=session,
            project_id=project_id,
            question=question,
            provider=provider,
            force_regenerate=payload.force_regenerate,
        )
    except MissingProviderCredentialsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except UnsupportedDocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=f"Reference generation failed: {exc}") from exc

    chunks = [
        RetrievedChunk(
            text=c.get("text", ""),
            source=c.get("source"),
            filename=c.get("source"),
            score=c.get("score"),
        )
        for c in ref.retrieved_chunks
    ]
    return ReferenceResponse(
        project_id=project_id,
        question=ref.row.question,
        answer=ref.row.answer,
        retrieved_chunks=chunks,
        cached=ref.cached,
        created_at=ref.row.created_at,
    )
