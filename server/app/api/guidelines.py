from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path, PurePosixPath, PureWindowsPath

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..config import settings
from ..db import get_session
from ..engines.guideline_builder import build_guidelines_stream
from ..models import GuidelineFile, Project

router = APIRouter()


class GuidelineRead(BaseModel):
    id: str
    project_id: str
    filename: str
    path: str
    content: str
    uploaded_at: datetime


def _safe_upload_name(raw: str | None) -> str:
    candidate = (raw or "").strip()
    if not candidate:
        raise HTTPException(status_code=400, detail="Filename is required")
    if PurePosixPath(candidate).is_absolute() or PureWindowsPath(candidate).is_absolute():
        raise HTTPException(status_code=400, detail="Invalid filename")
    name = Path(candidate).name
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="Invalid filename")
    return name


@router.post(
    "/projects/{project_id}/guidelines",
    response_model=GuidelineRead,
    status_code=201,
)
async def upload_guideline(
    project_id: str,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> GuidelineRead:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    g_dir = settings.projects_path / project_id / "guidelines"
    g_dir.mkdir(parents=True, exist_ok=True)

    filename = _safe_upload_name(file.filename)
    dest = g_dir / filename
    if not dest.resolve().is_relative_to(g_dir.resolve()):
        raise HTTPException(status_code=400, detail="Invalid filename")

    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)

    try:
        raw = dest.read_bytes()
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        content = raw.decode("utf-8", errors="replace")

    gf = GuidelineFile(
        project_id=project_id,
        filename=filename,
        path=str(dest.resolve()),
        content=content,
    )
    session.add(gf)
    session.commit()
    session.refresh(gf)
    return GuidelineRead(**gf.model_dump())


@router.get("/projects/{project_id}/guidelines", response_model=list[GuidelineRead])
def list_guidelines(
    project_id: str,
    session: Session = Depends(get_session),
) -> list[GuidelineRead]:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    rows = session.exec(select(GuidelineFile).where(GuidelineFile.project_id == project_id)).all()
    return [GuidelineRead(**g.model_dump()) for g in rows]


class GuidelineUpdate(BaseModel):
    content: str


@router.put(
    "/projects/{project_id}/guidelines/{guideline_id}",
    response_model=GuidelineRead,
)
def update_guideline(
    project_id: str,
    guideline_id: str,
    body: GuidelineUpdate,
    session: Session = Depends(get_session),
) -> GuidelineRead:
    gf = session.get(GuidelineFile, guideline_id)
    if gf is None or gf.project_id != project_id:
        raise HTTPException(status_code=404, detail="Guideline not found")
    gf.content = body.content
    try:
        Path(gf.path).write_text(body.content, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not write file: {exc}") from exc
    gf.uploaded_at = datetime.utcnow()
    session.add(gf)
    session.commit()
    session.refresh(gf)
    return GuidelineRead(**gf.model_dump())


@router.delete("/projects/{project_id}/guidelines/{guideline_id}", status_code=204)
def delete_guideline(
    project_id: str,
    guideline_id: str,
    session: Session = Depends(get_session),
) -> None:
    gf = session.get(GuidelineFile, guideline_id)
    if gf is None or gf.project_id != project_id:
        raise HTTPException(status_code=404, detail="Guideline not found")
    try:
        p = Path(gf.path)
        if p.exists():
            p.unlink()
    except OSError:
        pass
    session.delete(gf)
    session.commit()


class BuildGuidelinesRequest(BaseModel):
    provider: str | None = None


@router.post("/projects/{project_id}/guidelines/build")
async def build_guidelines(
    project_id: str,
    body: BuildGuidelinesRequest,
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """Stream Server-Sent Events as AI authors guideline files from indexed docs."""
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    async def event_stream():
        try:
            async for event in build_guidelines_stream(project_id, provider=body.provider):
                yield f"data: {json.dumps({'type': event.type, **event.payload})}\n\n"
        except Exception as exc:  # pragma: no cover
            payload = {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
            yield f"data: {json.dumps(payload)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
