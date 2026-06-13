from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path, PurePosixPath, PureWindowsPath

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..config import settings
from ..db import engine as db_engine, get_session
from ..engines.rag import delete_document_chunks, index_document
from ..engines.web import (
    _strip_outer_code_fence,
    discover_urls,
    ingest_url_stream,
)
from ..models import Document, Project

router = APIRouter()


class DocumentRead(BaseModel):
    id: str
    project_id: str
    filename: str
    path: str
    indexed_at: datetime | None = None
    indexing_error: str | None = None


def _safe_upload_name(raw: str | None) -> str:
    """Reject empty / traversal / absolute filenames; return a basename."""
    candidate = (raw or "").strip()
    if not candidate:
        raise HTTPException(status_code=400, detail="Filename is required")
    # Reject absolute paths on either platform.
    if PurePosixPath(candidate).is_absolute() or PureWindowsPath(candidate).is_absolute():
        raise HTTPException(status_code=400, detail="Invalid filename")
    name = Path(candidate).name
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="Invalid filename")
    return name


@router.post(
    "/projects/{project_id}/documents",
    response_model=DocumentRead,
    status_code=201,
)
async def upload_document(
    project_id: str,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> DocumentRead:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    docs_dir = settings.projects_path / project_id / "docs"
    docs_dir.mkdir(parents=True, exist_ok=True)

    filename = _safe_upload_name(file.filename)
    dest = docs_dir / filename
    # Make sure the resolved destination stays within docs_dir.
    if not dest.resolve().is_relative_to(docs_dir.resolve()):
        raise HTTPException(status_code=400, detail="Invalid filename")

    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)

    doc = Document(
        project_id=project_id,
        filename=filename,
        path=str(dest.resolve()),
    )
    session.add(doc)
    session.commit()
    session.refresh(doc)

    indexing_error: str | None = None
    try:
        await index_document(project_id, dest)
        doc.indexed_at = datetime.utcnow()
        session.add(doc)
        session.commit()
        session.refresh(doc)
    except Exception as exc:
        indexing_error = f"{type(exc).__name__}: {exc}"

    payload = doc.model_dump()
    payload["indexing_error"] = indexing_error
    return DocumentRead(**payload)


@router.get("/projects/{project_id}/documents", response_model=list[DocumentRead])
def list_documents(
    project_id: str,
    session: Session = Depends(get_session),
) -> list[DocumentRead]:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    rows = session.exec(select(Document).where(Document.project_id == project_id)).all()
    return [DocumentRead(**d.model_dump()) for d in rows]


class DiscoverUrlsRequest(BaseModel):
    url: str
    max_pages: int = Field(default=50, ge=1, le=200)


class DiscoverUrlsResponse(BaseModel):
    urls: list[str]


@router.post(
    "/projects/{project_id}/documents/url/discover",
    response_model=DiscoverUrlsResponse,
)
async def discover_url(
    project_id: str,
    body: DiscoverUrlsRequest,
    session: Session = Depends(get_session),
) -> DiscoverUrlsResponse:
    """Return the list of same-host pages we'd ingest, without indexing them.

    Lets the UI show a sitemap preview so the user can pick which pages to keep.
    """
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        urls = await discover_urls(body.url, body.max_pages)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"{type(exc).__name__}: {exc}") from exc
    return DiscoverUrlsResponse(urls=urls)


class IngestUrlRequest(BaseModel):
    url: str = ""  # seed URL — optional when `urls` is given
    max_pages: int = Field(default=20, ge=1, le=200)
    urls: list[str] | None = None  # explicit page list (skips discovery)
    smart_extract: bool = True  # AI distills each page before indexing
    provider: str | None = None  # AI provider override for distillation
    concurrency: int = Field(default=5, ge=1, le=16)  # pages processed in parallel


@router.post("/projects/{project_id}/documents/url")
async def ingest_url(
    project_id: str,
    body: IngestUrlRequest,
) -> StreamingResponse:
    """Stream Server-Sent Events as we crawl, extract, and index a docs URL.

    Each event is `data: <json>\\n\\n` with a `type` field of:
      - "status": top-level progress message
      - "page":   per-page result (indexed | skipped | failed)
      - "done":   final summary
      - "error":  fatal error (stream ends)
    """
    # Validate project up front so we can return 404 instead of an SSE error.
    with Session(db_engine) as session:
        project = session.get(Project, project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")

    async def event_stream():
        # Use a session local to this generator so its lifetime matches the
        # stream — request-scoped Depends is closed before generation starts.
        session = Session(db_engine)
        try:
            async for event in ingest_url_stream(
                project_id,
                body.url,
                body.max_pages,
                urls=body.urls,
                smart_extract=body.smart_extract,
                provider=body.provider,
                concurrency=body.concurrency,
            ):
                # Persist a Document row per successfully indexed page so the
                # UI's existing list refreshes naturally.
                if event.type == "page" and event.payload.get("status") == "indexed":
                    url = str(event.payload.get("url") or "")
                    title = str(event.payload.get("title") or url)
                    indexed_text = event.payload.get("_indexed_text")
                    distilled = bool(event.payload.get("distilled"))
                    if url:
                        existing = session.exec(
                            select(Document)
                            .where(Document.project_id == project_id)
                            .where(Document.path == url)
                        ).first()
                        if existing is None:
                            session.add(
                                Document(
                                    project_id=project_id,
                                    filename=title[:200],
                                    path=url,
                                    indexed_at=datetime.utcnow(),
                                    indexed_text=indexed_text,
                                    distilled=distilled,
                                )
                            )
                        else:
                            existing.indexed_at = datetime.utcnow()
                            if indexed_text is not None:
                                existing.indexed_text = indexed_text
                            existing.distilled = distilled
                            session.add(existing)
                        session.commit()

                # Consolidated files (Smart-extract mode) persist as Document
                # rows with a synthetic `consolidated://<slug>` path so the
                # standard documents list and preview pane handle them too.
                if event.type == "file" and event.payload.get("status") == "saved":
                    slug = str(event.payload.get("slug") or "").strip()
                    title = str(event.payload.get("title") or slug)
                    indexed_text = event.payload.get("_indexed_text") or ""
                    if slug:
                        synth_path = f"consolidated://{project_id}/{slug}"
                        existing = session.exec(
                            select(Document)
                            .where(Document.project_id == project_id)
                            .where(Document.path == synth_path)
                        ).first()
                        if existing is None:
                            session.add(
                                Document(
                                    project_id=project_id,
                                    filename=f"{title} ({slug}.md)"[:200],
                                    path=synth_path,
                                    indexed_at=datetime.utcnow(),
                                    indexed_text=indexed_text,
                                    distilled=True,
                                )
                            )
                        else:
                            existing.indexed_at = datetime.utcnow()
                            existing.indexed_text = indexed_text
                            existing.distilled = True
                            existing.filename = f"{title} ({slug}.md)"[:200]
                            session.add(existing)
                        session.commit()

                # Strip internal fields before serializing to SSE.
                public_payload = {
                    k: v for k, v in event.payload.items() if not k.startswith("_")
                }
                yield f"data: {json.dumps({'type': event.type, **public_payload})}\n\n"
        except Exception as exc:  # pragma: no cover - defensive
            payload = {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
            yield f"data: {json.dumps(payload)}\n\n"
        finally:
            session.close()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering for SSE
            "Connection": "keep-alive",
        },
    )


class DocumentContent(BaseModel):
    id: str
    filename: str
    path: str
    kind: str  # "file" | "url" | "consolidated"
    content: str | None = None  # text content for file docs, None for URL docs
    url: str | None = None  # set when kind == "url"
    distilled: bool = False  # true when content is an AI-distilled brief


@router.get(
    "/projects/{project_id}/documents/{document_id}/content",
    response_model=DocumentContent,
)
def get_document_content(
    project_id: str,
    document_id: str,
    session: Session = Depends(get_session),
) -> DocumentContent:
    """Return the textual content of a document for preview.

    URL-ingested docs (path is an http(s) URL) return kind="url" with the URL
    in `url` and no content — the client should open the URL in a new tab.
    Locally uploaded text-like files (.md/.txt/.markdown) return their UTF-8
    decoded content. PDFs/DOCX return a notice that previews aren't supported
    inline yet.
    """
    doc = session.get(Document, document_id)
    if doc is None or doc.project_id != project_id:
        raise HTTPException(status_code=404, detail="Document not found")

    # Strip any LLM-added outer ```markdown ... ``` wrapper at read time so
    # rows generated before the engine-side fix render correctly.
    cleaned = _strip_outer_code_fence(doc.indexed_text) if doc.indexed_text else None

    if doc.path.startswith(("http://", "https://")):
        return DocumentContent(
            id=doc.id,
            filename=doc.filename,
            path=doc.path,
            kind="url",
            url=doc.path,
            content=cleaned,  # may be the AI-distilled markdown
            distilled=bool(doc.distilled),
        )

    if doc.path.startswith("consolidated://"):
        return DocumentContent(
            id=doc.id,
            filename=doc.filename,
            path=doc.path,
            kind="consolidated",
            content=cleaned or "",
            distilled=True,
        )

    p = Path(doc.path)
    if not p.exists():
        raise HTTPException(status_code=410, detail="Document file is missing on disk")

    suffix = p.suffix.lower()
    if suffix in {".md", ".markdown", ".txt"}:
        try:
            text = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = p.read_bytes().decode("utf-8", errors="replace")
        return DocumentContent(
            id=doc.id,
            filename=doc.filename,
            path=doc.path,
            kind="file",
            content=text,
        )

    # Binary or non-text. Surface a friendly message rather than dumping bytes.
    return DocumentContent(
        id=doc.id,
        filename=doc.filename,
        path=doc.path,
        kind="file",
        content=f"(Inline preview is not available for {suffix or 'this'} files.)",
    )


@router.delete("/projects/{project_id}/documents/{document_id}", status_code=204)
async def delete_document(
    project_id: str,
    document_id: str,
    session: Session = Depends(get_session),
) -> None:
    import logging
    import os

    logger = logging.getLogger(__name__)

    doc = session.get(Document, document_id)
    if doc is None or doc.project_id != project_id:
        raise HTTPException(status_code=404, detail="Document not found")

    # Remove vector chunks first; tolerate missing collection / no matches.
    try:
        deleted = await delete_document_chunks(project_id, doc.path)
        logger.info(
            "Deleted %d vector chunks for document %s (path=%s)",
            deleted,
            document_id,
            doc.path,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Vector chunk cleanup failed for %s: %s", document_id, exc)

    # Remove on-disk file (only for filesystem-backed docs, not URLs / consolidated).
    if not doc.path.startswith(("http://", "https://", "consolidated://")):
        try:
            if os.path.exists(doc.path):
                os.unlink(doc.path)
        except OSError:
            pass

    session.delete(doc)
    session.commit()
