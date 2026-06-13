from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import settings


class UnsupportedDocumentError(Exception):
    """Raised when a document's file type cannot be loaded."""


@dataclass
class Chunk:
    text: str
    source: str
    score: float = 0.0


@dataclass
class ReferenceResult:
    answer: str
    retrieved_chunks: list[Chunk]
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


REFERENCE_PROMPT_TEMPLATE = """You are generating an ideal reference answer that the chatbot under test SHOULD have produced.

Question:
{question}

Relevant documents:
{retrieved_chunks}

Company guidelines:
{guidelines}

Write a concise, accurate answer grounded ONLY in the documents and guidelines. If the documents don't contain enough information, state that the bot should say it does not know. Do not invent facts."""


REFERENCE_PROMPT_WITH_CONTEXT_TEMPLATE = """You are generating an ideal reference answer that the chatbot under test SHOULD have produced, given the prior conversation history.

Conversation so far:
{prior_context}

Latest user question:
{question}

Relevant documents:
{retrieved_chunks}

Company guidelines:
{guidelines}

Write a concise, accurate answer the assistant should give as its next turn, grounded ONLY in the documents and guidelines and consistent with the conversation history. If the documents don't contain enough information, state that the bot should say it does not know. Do not invent facts."""


# --- Module-level singletons (lazy) -----------------------------------------

_embedding_fn: Any | None = None
_chroma_client: Any | None = None


def _get_embedding_function() -> Any:
    global _embedding_fn
    if _embedding_fn is None:
        from chromadb.utils import embedding_functions

        _embedding_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
            model_name="sentence-transformers/all-MiniLM-L6-v2"
        )
    return _embedding_fn


def _get_chroma_client() -> Any:
    global _chroma_client
    if _chroma_client is None:
        import chromadb

        chroma_dir = settings.chroma_path
        chroma_dir.mkdir(parents=True, exist_ok=True)
        _chroma_client = chromadb.PersistentClient(path=str(chroma_dir))
    return _chroma_client


def _collection_name(project_id: str) -> str:
    # Chroma collection names must be 3-63 chars, alnum/_/-. UUIDs are fine.
    safe = project_id.replace("-", "_")
    return f"project_{safe}"


def _refcache_collection_name(project_id: str) -> str:
    safe = project_id.replace("-", "_")
    return f"refcache_{safe}"


def _get_or_create_collection(project_id: str) -> Any:
    client = _get_chroma_client()
    return client.get_or_create_collection(
        name=_collection_name(project_id),
        embedding_function=_get_embedding_function(),
    )


def _get_or_create_refcache(project_id: str) -> Any:
    client = _get_chroma_client()
    return client.get_or_create_collection(
        name=_refcache_collection_name(project_id),
        embedding_function=_get_embedding_function(),
    )


# --- Document loaders -------------------------------------------------------


def _load_pdf(path: Path) -> str:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    parts: list[str] = []
    for page in reader.pages:
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            parts.append("")
    return "\n".join(parts)


def _load_docx(path: Path) -> str:
    import docx  # python-docx

    document = docx.Document(str(path))
    return "\n".join(p.text for p in document.paragraphs)


def _load_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def _load_document(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return _load_pdf(path)
    if suffix == ".docx":
        return _load_docx(path)
    if suffix in {".md", ".markdown", ".txt"}:
        return _load_text(path)
    raise UnsupportedDocumentError(f"Unsupported document type: {suffix}")


# --- Chunking ---------------------------------------------------------------


def _chunk_text(text: str, window: int = 800, overlap: int = 100) -> list[str]:
    tokens = text.split()
    if not tokens:
        return []
    if window <= 0:
        window = 800
    if overlap < 0 or overlap >= window:
        overlap = max(0, min(overlap, window - 1))
    step = window - overlap
    chunks: list[str] = []
    for start in range(0, len(tokens), step):
        piece = tokens[start : start + window]
        if not piece:
            break
        chunks.append(" ".join(piece))
        if start + window >= len(tokens):
            break
    return chunks


# --- Sync helpers (run via asyncio.to_thread) -------------------------------


def _index_document_sync(project_id: str, file_path: Path) -> int:
    text = _load_document(file_path)
    chunks = _chunk_text(text)
    if not chunks:
        return 0

    collection = _get_or_create_collection(project_id)
    source = str(file_path)
    # Deterministic ids per (source, index) so re-indexing replaces existing.
    base = hashlib.sha1(source.encode("utf-8")).hexdigest()[:16]
    ids = [f"{base}_{i}" for i in range(len(chunks))]
    metadatas = [
        {"source": source, "filename": file_path.name, "chunk_index": i} for i in range(len(chunks))
    ]
    collection.upsert(ids=ids, documents=chunks, metadatas=metadatas)
    return len(chunks)


def _retrieve_sync(project_id: str, query: str, k: int) -> list[Chunk]:
    collection = _get_or_create_collection(project_id)
    res = collection.query(query_texts=[query], n_results=k)
    docs: list[str] = (res.get("documents") or [[]])[0]
    metas: list[dict[str, Any]] = (res.get("metadatas") or [[]])[0]
    dists: list[float] = (res.get("distances") or [[]])[0]
    out: list[Chunk] = []
    for i, text in enumerate(docs):
        meta = metas[i] if i < len(metas) else {}
        dist = dists[i] if i < len(dists) else 0.0
        # Convert distance to similarity score in [0, 1].
        score = max(0.0, 1.0 - float(dist))
        source = str(meta.get("source") or meta.get("filename") or "")
        out.append(Chunk(text=text, source=source, score=score))
    return out


def _delete_collection_sync(project_id: str) -> None:
    client = _get_chroma_client()
    for name in (_collection_name(project_id), _refcache_collection_name(project_id)):
        try:
            client.delete_collection(name=name)
        except Exception:
            # Idempotent: missing collection is fine.
            pass


def _index_reference_question_sync(project_id: str, reference_id: str, question: str) -> None:
    if not question or not question.strip():
        return
    collection = _get_or_create_refcache(project_id)
    collection.upsert(
        ids=[reference_id],
        documents=[question.strip()],
        metadatas=[{"reference_id": reference_id}],
    )


def _find_similar_reference_sync(
    project_id: str, question: str, threshold: float
) -> tuple[str, float] | None:
    if not question or not question.strip():
        return None
    collection = _get_or_create_refcache(project_id)
    try:
        res = collection.query(query_texts=[question.strip()], n_results=1)
    except Exception:
        return None
    ids: list[str] = (res.get("ids") or [[]])[0]
    dists: list[float] = (res.get("distances") or [[]])[0]
    if not ids:
        return None
    similarity = max(0.0, 1.0 - float(dists[0]))
    if similarity < threshold:
        return None
    return ids[0], similarity


def _delete_reference_from_cache_sync(project_id: str, reference_id: str) -> None:
    try:
        collection = _get_or_create_refcache(project_id)
        collection.delete(ids=[reference_id])
    except Exception:
        pass


def _delete_document_chunks_sync(project_id: str, document_path: str) -> int:
    """Delete chunks whose metadata.source == document_path. Returns count."""
    try:
        client = _get_chroma_client()
        # Avoid auto-creating the collection just to delete from it.
        try:
            collection = client.get_collection(
                name=_collection_name(project_id),
                embedding_function=_get_embedding_function(),
            )
        except Exception:
            # Collection doesn't exist — nothing to delete.
            return 0
        try:
            existing = collection.get(where={"source": document_path})
            ids = existing.get("ids") or []
            count = len(ids)
        except Exception:
            count = 0
        try:
            collection.delete(where={"source": document_path})
        except Exception:
            return 0
        return count
    except Exception:
        return 0


# --- Public API -------------------------------------------------------------


async def index_document(project_id: str, file_path: Path) -> int:
    """Load, chunk, embed, and upsert. Returns chunk count."""
    return await asyncio.to_thread(_index_document_sync, project_id, file_path)


async def retrieve(project_id: str, query: str, k: int = 5) -> list[Chunk]:
    """Top-k chunks."""
    return await asyncio.to_thread(_retrieve_sync, project_id, query, k)


def _format_chunks(chunks: Iterable[Chunk]) -> str:
    parts: list[str] = []
    for i, c in enumerate(chunks, start=1):
        src = c.source or "unknown"
        parts.append(f"[{i}] (source: {src})\n{c.text}")
    return "\n\n".join(parts) if parts else "(no documents retrieved)"


def _format_guidelines(texts: Iterable[str]) -> str:
    items = [t for t in texts if t and t.strip()]
    if not items:
        return "(none)"
    return "\n\n---\n\n".join(items)


async def generate_reference(
    project_id: str,
    question: str,
    guideline_texts: list[str],
    provider: str | None = None,
    prior_context: str | None = None,
) -> ReferenceResult:
    """Retrieve, build prompt, and call the AI chat layer for a reference answer.

    When `prior_context` is provided, it is rendered before the question so the
    reference answer is conditioned on the running conversation transcript.
    """
    from . import ai  # Local import to avoid import cycles at module load.

    # Retrieval query: bias on the latest user question, optionally seeded with
    # the tail of the prior context.
    retrieve_query = question
    if prior_context:
        retrieve_query = f"{prior_context}\n\n{question}"[-2000:]
    retrieved = await retrieve(project_id, retrieve_query, k=5)
    if prior_context:
        prompt = REFERENCE_PROMPT_WITH_CONTEXT_TEMPLATE.format(
            prior_context=prior_context,
            question=question,
            retrieved_chunks=_format_chunks(retrieved),
            guidelines=_format_guidelines(guideline_texts),
        )
    else:
        prompt = REFERENCE_PROMPT_TEMPLATE.format(
            question=question,
            retrieved_chunks=_format_chunks(retrieved),
            guidelines=_format_guidelines(guideline_texts),
        )
    answer, usage = await ai.chat(prompt, provider=provider)
    return ReferenceResult(
        answer=answer,
        retrieved_chunks=retrieved,
        prompt_tokens=int(getattr(usage, "prompt", 0) or 0),
        completion_tokens=int(getattr(usage, "completion", 0) or 0),
        total_tokens=int(getattr(usage, "total", 0) or 0),
    )


async def generate_reference_with_context(
    project_id: str,
    user_question: str,
    prior_context: str,
    guideline_texts: list[str],
    provider: str | None = None,
) -> ReferenceResult:
    """Convenience wrapper that forwards to generate_reference with prior_context."""
    return await generate_reference(
        project_id=project_id,
        question=user_question,
        guideline_texts=guideline_texts,
        provider=provider,
        prior_context=prior_context,
    )


async def delete_project_collection(project_id: str) -> None:
    """Drop the Chroma collection for a project. Idempotent."""
    await asyncio.to_thread(_delete_collection_sync, project_id)


async def index_reference_question(project_id: str, reference_id: str, question: str) -> None:
    """Embed a question and link it to a ReferenceAnswer row for semantic reuse."""
    await asyncio.to_thread(_index_reference_question_sync, project_id, reference_id, question)


async def find_similar_reference(
    project_id: str, question: str, threshold: float
) -> tuple[str, float] | None:
    """Return (reference_id, similarity) for the closest cached question, or None."""
    return await asyncio.to_thread(_find_similar_reference_sync, project_id, question, threshold)


async def delete_reference_from_cache(project_id: str, reference_id: str) -> None:
    """Remove a single reference from the semantic cache. Idempotent."""
    await asyncio.to_thread(_delete_reference_from_cache_sync, project_id, reference_id)


async def delete_document_chunks(project_id: str, document_path: str) -> int:
    """Remove every chunk whose metadata.source == document_path from the
    project's Chroma collection. Returns count deleted. Idempotent — if the
    collection doesn't exist or no chunks match, returns 0."""
    return await asyncio.to_thread(_delete_document_chunks_sync, project_id, document_path)
