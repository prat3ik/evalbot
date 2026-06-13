"""Shared helper for reference-answer generation with caching."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from sqlmodel import Session, select

from ..config import settings
from ..engines import rag
from ..models import GuidelineFile, ReferenceAnswer


def question_hash(project_id: str, question: str) -> str:
    h = hashlib.sha256()
    h.update(project_id.encode("utf-8"))
    h.update(b"\x00")
    h.update(question.strip().encode("utf-8"))
    return h.hexdigest()


def load_guideline_texts(session: Session, project_id: str) -> list[str]:
    rows = session.exec(select(GuidelineFile).where(GuidelineFile.project_id == project_id)).all()
    return [g.content for g in rows if g.content]


@dataclass
class ReferencePayload:
    row: ReferenceAnswer
    cached: bool
    retrieved_chunks: list[dict]
    # Token usage from the LLM call that generated this reference. On cache
    # reuse these are 0 — the reference came from the cached row and no new
    # tokens were consumed by THIS evaluation.
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    # When the cache hit came from semantic similarity (not exact-hash match),
    # this is the cosine similarity in [0, 1]. None on miss or exact hit.
    semantic_similarity: float | None = None


def _chunks_to_json(chunks) -> list[dict]:
    return [{"text": c.text, "source": c.source, "score": float(c.score)} for c in chunks]


async def get_or_create_reference(
    session: Session,
    project_id: str,
    question: str,
    provider: str | None = None,
    force_regenerate: bool = False,
) -> ReferencePayload:
    qhash = question_hash(project_id, question)

    if not force_regenerate:
        existing = session.exec(
            select(ReferenceAnswer)
            .where(ReferenceAnswer.project_id == project_id)
            .where(ReferenceAnswer.question_hash == qhash)
        ).first()
        if existing is not None:
            try:
                chunks = json.loads(existing.retrieved_chunks_json or "[]")
            except json.JSONDecodeError:
                chunks = []
            # Cached reuse: zero tokens attributed to THIS evaluation. The
            # tokens used to originally generate this reference were recorded
            # on the evaluation that first created it.
            return ReferencePayload(row=existing, cached=True, retrieved_chunks=chunks)

        if settings.REFERENCE_SEMANTIC_CACHE_ENABLED:
            match = await rag.find_similar_reference(
                project_id=project_id,
                question=question,
                threshold=settings.REFERENCE_SEMANTIC_CACHE_THRESHOLD,
            )
            if match is not None:
                ref_id, similarity = match
                cached_row = session.get(ReferenceAnswer, ref_id)
                if cached_row is not None and cached_row.project_id == project_id:
                    try:
                        chunks = json.loads(cached_row.retrieved_chunks_json or "[]")
                    except json.JSONDecodeError:
                        chunks = []
                    return ReferencePayload(
                        row=cached_row,
                        cached=True,
                        retrieved_chunks=chunks,
                        semantic_similarity=similarity,
                    )
                # Stale pointer (row was deleted): purge from cache and fall through.
                await rag.delete_reference_from_cache(project_id, ref_id)

    guideline_texts = load_guideline_texts(session, project_id)
    result = await rag.generate_reference(
        project_id=project_id,
        question=question,
        guideline_texts=guideline_texts,
        provider=provider,
    )
    chunks_json = _chunks_to_json(result.retrieved_chunks)
    row = ReferenceAnswer(
        project_id=project_id,
        question_hash=qhash,
        question=question,
        answer=result.answer,
        retrieved_chunks_json=json.dumps(chunks_json),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    if settings.REFERENCE_SEMANTIC_CACHE_ENABLED:
        await rag.index_reference_question(project_id, row.id, question)
    return ReferencePayload(
        row=row,
        cached=False,
        retrieved_chunks=chunks_json,
        prompt_tokens=int(getattr(result, "prompt_tokens", 0) or 0),
        completion_tokens=int(getattr(result, "completion_tokens", 0) or 0),
        total_tokens=int(getattr(result, "total_tokens", 0) or 0),
    )
