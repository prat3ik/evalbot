# CUSTOM_CHECKS_DISABLED — restore the body below to re-enable.
"""CRUD API for per-project plain-English custom checks (DISABLED).

The original implementation is commented out below. We still export an empty
APIRouter so ``app.main`` imports keep working; including this router is a
no-op while the feature is disabled.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()

# CUSTOM_CHECKS_DISABLED — original module body below; uncomment to re-enable.
# from datetime import datetime
#
# from fastapi import APIRouter, Depends, HTTPException
# from pydantic import BaseModel, Field
# from sqlmodel import Session, select
#
# from ..db import get_session
# from ..models import CustomCheck, Project
#
# router = APIRouter()
#
#
# class CustomCheckRead(BaseModel):
#     id: str
#     project_id: str
#     description: str
#     weight: float
#     created_at: datetime
#
#
# class CustomCheckCreate(BaseModel):
#     description: str = Field(..., min_length=1, max_length=2000)
#     weight: float = 0.0
#
#
# class CustomCheckUpdate(BaseModel):
#     description: str | None = Field(default=None, min_length=1, max_length=2000)
#     weight: float | None = None
#
#
# def _serialize(c: CustomCheck) -> CustomCheckRead:
#     return CustomCheckRead(
#         id=c.id,
#         project_id=c.project_id,
#         description=c.description,
#         weight=float(c.weight),
#         created_at=c.created_at,
#     )
#
#
# def _clamp_weight(w: float) -> float:
#     try:
#         v = float(w)
#     except (TypeError, ValueError):
#         return 0.0
#     if v < 0.0:
#         return 0.0
#     if v > 1.0:
#         return 1.0
#     return v
#
#
# @router.get(
#     "/projects/{project_id}/custom-checks",
#     response_model=list[CustomCheckRead],
# )
# def list_custom_checks(
#     project_id: str,
#     session: Session = Depends(get_session),
# ) -> list[CustomCheckRead]:
#     if session.get(Project, project_id) is None:
#         raise HTTPException(status_code=404, detail="Project not found")
#     rows = session.exec(
#         select(CustomCheck)
#         .where(CustomCheck.project_id == project_id)
#         .order_by(CustomCheck.created_at)
#     ).all()
#     return [_serialize(r) for r in rows]
#
#
# @router.post(
#     "/projects/{project_id}/custom-checks",
#     response_model=CustomCheckRead,
#     status_code=201,
# )
# def create_custom_check(
#     project_id: str,
#     payload: CustomCheckCreate,
#     session: Session = Depends(get_session),
# ) -> CustomCheckRead:
#     if session.get(Project, project_id) is None:
#         raise HTTPException(status_code=404, detail="Project not found")
#     description = payload.description.strip()
#     if not description:
#         raise HTTPException(status_code=400, detail="description must be non-empty")
#     row = CustomCheck(
#         project_id=project_id,
#         description=description,
#         weight=_clamp_weight(payload.weight),
#     )
#     session.add(row)
#     session.commit()
#     session.refresh(row)
#     return _serialize(row)
#
#
# @router.patch("/custom-checks/{check_id}", response_model=CustomCheckRead)
# def update_custom_check(
#     check_id: str,
#     payload: CustomCheckUpdate,
#     session: Session = Depends(get_session),
# ) -> CustomCheckRead:
#     row = session.get(CustomCheck, check_id)
#     if row is None:
#         raise HTTPException(status_code=404, detail="Custom check not found")
#     if payload.description is not None:
#         new_desc = payload.description.strip()
#         if not new_desc:
#             raise HTTPException(status_code=400, detail="description must be non-empty")
#         row.description = new_desc
#     if payload.weight is not None:
#         row.weight = _clamp_weight(payload.weight)
#     session.add(row)
#     session.commit()
#     session.refresh(row)
#     return _serialize(row)
#
#
# @router.delete("/custom-checks/{check_id}", status_code=204)
# def delete_custom_check(
#     check_id: str,
#     session: Session = Depends(get_session),
# ) -> None:
#     row = session.get(CustomCheck, check_id)
#     if row is None:
#         raise HTTPException(status_code=404, detail="Custom check not found")
#     session.delete(row)
#     session.commit()
#     return None
