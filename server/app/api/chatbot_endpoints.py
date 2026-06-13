"""CRUD + test-connection routes for ChatbotEndpoint rows.

A project can have N named endpoints. Each carries its own URL, request
template, response-text JSONPath, and (optional) token-field JSONPaths. The
``/test`` route lets users verify a config with a sample question before
running a full dataset against it.
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..models import ChatbotEndpoint, Project

router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ChatbotEndpointCreate(BaseModel):
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
    test_question: str | None = None


class ChatbotEndpointUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    method: str | None = None
    headers_json: str | None = None
    request_template: str | None = None
    response_path: str | None = None
    tokens_prompt_path: str | None = None
    tokens_completion_path: str | None = None
    tokens_total_path: str | None = None
    timeout_seconds: float | None = None
    is_default: bool | None = None
    test_question: str | None = None


class ChatbotEndpointOut(BaseModel):
    id: str
    project_id: str
    name: str
    url: str
    method: str
    headers_json: str
    request_template: str
    response_path: str
    tokens_prompt_path: str | None
    tokens_completion_path: str | None
    tokens_total_path: str | None
    timeout_seconds: float
    is_default: bool
    test_question: str | None
    created_at: datetime


class ChatbotEndpointTestRequest(BaseModel):
    question: str = "Hello, this is a test question."


class ChatbotEndpointTestResult(BaseModel):
    response_text: str
    raw_response: Any
    response_path_resolved: str
    prompt_tokens: int | None
    completion_tokens: int | None
    total_tokens: int | None
    latency_ms: int
    error: str | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_out(e: ChatbotEndpoint) -> ChatbotEndpointOut:
    # Explicit field access so SQLAlchemy auto-loads expired attributes after
    # commit. `.model_dump()` can return `{}` on a detached/expired SQLModel
    # row, which silently fails Pydantic validation downstream.
    return ChatbotEndpointOut(
        id=e.id,
        project_id=e.project_id,
        name=e.name,
        url=e.url,
        method=e.method,
        headers_json=e.headers_json,
        request_template=e.request_template,
        response_path=e.response_path,
        tokens_prompt_path=e.tokens_prompt_path,
        tokens_completion_path=e.tokens_completion_path,
        tokens_total_path=e.tokens_total_path,
        timeout_seconds=e.timeout_seconds,
        is_default=e.is_default,
        test_question=e.test_question,
        created_at=e.created_at,
    )


def _jsonpath_get(payload: Any, path: str | None) -> Any:
    """Minimal `$.a.b.c` dot-path extractor.

    Supports numeric indices via `$.a.0.b` (no bracket syntax beyond what falls
    out of the split). Returns None if any step misses. Deferred: full JSONPath
    (filters, wildcards, recursive descent).
    """
    if not path:
        return None
    parts = re.split(r"[.\[\]]", path.lstrip("$").lstrip("."))
    cur: Any = payload
    for p in parts:
        if not p:
            continue
        if isinstance(cur, dict) and p in cur:
            cur = cur[p]
        elif isinstance(cur, list):
            try:
                cur = cur[int(p)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return cur


def _render_template(template: str, *, question: str) -> Any:
    """Render `{{question}}` / `{{conversation}}` and try to JSON-parse."""
    s = template.replace("{{question}}", question).replace("{{conversation}}", question)
    try:
        return json.loads(s)
    except Exception:
        safe = template.replace("{{question}}", json.dumps(question)[1:-1]).replace(
            "{{conversation}}", json.dumps(question)[1:-1]
        )
        try:
            return json.loads(safe)
        except Exception:
            return s


def _coerce_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _ensure_single_default(session: Session, project_id: str, keep_id: str) -> None:
    """Clear ``is_default`` on every other endpoint in the project."""
    rows = session.exec(
        select(ChatbotEndpoint).where(ChatbotEndpoint.project_id == project_id)
    ).all()
    for r in rows:
        if r.id == keep_id:
            continue
        if r.is_default:
            r.is_default = False
            session.add(r)


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/chatbot-endpoints",
    response_model=list[ChatbotEndpointOut],
)
def list_endpoints(
    project_id: str,
    session: Session = Depends(get_session),
) -> list[ChatbotEndpointOut]:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    rows = session.exec(
        select(ChatbotEndpoint).where(ChatbotEndpoint.project_id == project_id)
    ).all()
    # Default first, then by creation time.
    rows.sort(key=lambda e: (not e.is_default, e.created_at))
    return [_to_out(e) for e in rows]


@router.post(
    "/projects/{project_id}/chatbot-endpoints",
    response_model=ChatbotEndpointOut,
    status_code=201,
)
def create_endpoint(
    project_id: str,
    payload: ChatbotEndpointCreate,
    session: Session = Depends(get_session),
) -> ChatbotEndpointOut:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    name = payload.name.strip()
    url = payload.url.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    if not url:
        raise HTTPException(status_code=400, detail="url required")
    # Validate headers_json parses.
    try:
        json.loads(payload.headers_json or "{}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"headers_json must be valid JSON: {exc}") from exc

    existing = session.exec(
        select(ChatbotEndpoint).where(ChatbotEndpoint.project_id == project_id)
    ).all()
    is_default = payload.is_default or len(existing) == 0  # first one is default
    row = ChatbotEndpoint(
        project_id=project_id,
        name=name,
        url=url,
        method=(payload.method or "POST").upper(),
        headers_json=payload.headers_json or "{}",
        request_template=payload.request_template or '{"question": "{{question}}"}',
        response_path=payload.response_path or "$.response",
        tokens_prompt_path=payload.tokens_prompt_path or None,
        tokens_completion_path=payload.tokens_completion_path or None,
        tokens_total_path=payload.tokens_total_path or None,
        timeout_seconds=float(payload.timeout_seconds or 30.0),
        is_default=is_default,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    if row.is_default:
        _ensure_single_default(session, project_id, row.id)
        session.commit()
    return _to_out(row)


@router.get("/chatbot-endpoints/{endpoint_id}", response_model=ChatbotEndpointOut)
def get_endpoint(
    endpoint_id: str,
    session: Session = Depends(get_session),
) -> ChatbotEndpointOut:
    row = session.get(ChatbotEndpoint, endpoint_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Endpoint not found")
    return _to_out(row)


@router.patch("/chatbot-endpoints/{endpoint_id}", response_model=ChatbotEndpointOut)
def update_endpoint(
    endpoint_id: str,
    payload: ChatbotEndpointUpdate,
    session: Session = Depends(get_session),
) -> ChatbotEndpointOut:
    row = session.get(ChatbotEndpoint, endpoint_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Endpoint not found")
    if payload.name is not None:
        n = payload.name.strip()
        if not n:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        row.name = n
    if payload.url is not None:
        u = payload.url.strip()
        if not u:
            raise HTTPException(status_code=400, detail="url cannot be empty")
        row.url = u
    if payload.method is not None:
        row.method = (payload.method or "POST").upper()
    if payload.headers_json is not None:
        try:
            json.loads(payload.headers_json or "{}")
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"headers_json must be valid JSON: {exc}"
            ) from exc
        row.headers_json = payload.headers_json or "{}"
    if payload.request_template is not None:
        row.request_template = payload.request_template
    if payload.response_path is not None:
        row.response_path = payload.response_path or "$.response"
    if payload.tokens_prompt_path is not None:
        row.tokens_prompt_path = payload.tokens_prompt_path or None
    if payload.tokens_completion_path is not None:
        row.tokens_completion_path = payload.tokens_completion_path or None
    if payload.tokens_total_path is not None:
        row.tokens_total_path = payload.tokens_total_path or None
    if payload.timeout_seconds is not None:
        row.timeout_seconds = float(payload.timeout_seconds)
    if payload.is_default is not None:
        row.is_default = bool(payload.is_default)
    session.add(row)
    session.commit()
    session.refresh(row)
    if row.is_default:
        _ensure_single_default(session, row.project_id, row.id)
        session.commit()
        session.refresh(row)
    return _to_out(row)


@router.delete("/chatbot-endpoints/{endpoint_id}", status_code=204)
def delete_endpoint(
    endpoint_id: str,
    session: Session = Depends(get_session),
) -> None:
    row = session.get(ChatbotEndpoint, endpoint_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Endpoint not found")
    was_default = row.is_default
    project_id = row.project_id
    session.delete(row)
    session.commit()
    # Promote another endpoint to default if we just removed the default one.
    if was_default:
        remaining = session.exec(
            select(ChatbotEndpoint)
            .where(ChatbotEndpoint.project_id == project_id)
            .order_by(ChatbotEndpoint.created_at)
        ).all()
        if remaining:
            remaining[0].is_default = True
            session.add(remaining[0])
            session.commit()


# ---------------------------------------------------------------------------
# Test connection
# ---------------------------------------------------------------------------


@router.post(
    "/chatbot-endpoints/{endpoint_id}/test",
    response_model=ChatbotEndpointTestResult,
)
async def test_endpoint(
    endpoint_id: str,
    payload: ChatbotEndpointTestRequest,
    session: Session = Depends(get_session),
) -> ChatbotEndpointTestResult:
    ep = session.get(ChatbotEndpoint, endpoint_id)
    if ep is None:
        raise HTTPException(status_code=404, detail="Endpoint not found")

    body = _render_template(ep.request_template, question=payload.question)
    try:
        headers = json.loads(ep.headers_json or "{}")
        if not isinstance(headers, dict):
            headers = {}
    except Exception:
        headers = {}

    # Cap timeout at 5s for the Test Connection button regardless of the
    # endpoint's stored timeout — keeps the UI responsive on hangs.
    timeout = min(float(ep.timeout_seconds or 30.0), 5.0)
    started = time.perf_counter()
    err: str | None = None
    raw: Any = None
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(
                (ep.method or "POST").upper(),
                ep.url,
                json=body if isinstance(body, (dict, list)) else None,
                content=None if isinstance(body, (dict, list)) else str(body),
                headers={"Content-Type": "application/json", **headers},
            )
            try:
                raw = resp.json()
            except Exception:
                raw = resp.text
            if resp.status_code >= 400:
                err = f"HTTP {resp.status_code}: {resp.text[:200]}"
    except httpx.TimeoutException:
        err = f"Endpoint timed out after {timeout}s. The bot may be slow, down, or blocked by a firewall."
    except httpx.ConnectError as exc:
        msg = str(exc).lower()
        host = ""
        try:
            from urllib.parse import urlparse
            host = urlparse(ep.url).hostname or ep.url
        except Exception:
            host = ep.url
        if "nodename nor servname" in msg or "name or service not known" in msg or "getaddrinfo" in msg:
            err = f"Could not resolve host '{host}'. Check the endpoint URL or your network/DNS."
        elif "connection refused" in msg:
            err = f"Connection refused by '{host}'. The endpoint isn't accepting requests on that port."
        else:
            err = f"Could not reach '{host}'. The endpoint may be unreachable from this machine."
    except httpx.HTTPError as exc:
        err = f"Request to chatbot endpoint failed: {type(exc).__name__}."
    except Exception as exc:  # pragma: no cover - defensive
        err = f"Unexpected error contacting chatbot endpoint: {type(exc).__name__}."
    latency_ms = int((time.perf_counter() - started) * 1000)

    response_text = ""
    if raw is not None and err is None:
        v = _jsonpath_get(raw, ep.response_path) if isinstance(raw, (dict, list)) else None
        if v is None and isinstance(raw, str):
            response_text = raw
        elif isinstance(v, (dict, list)):
            response_text = json.dumps(v)
        elif v is not None:
            response_text = str(v)
        else:
            response_text = ""
            if not err:
                err = f"response_path '{ep.response_path}' did not match"

    prompt_tokens = (
        _coerce_int(_jsonpath_get(raw, ep.tokens_prompt_path))
        if ep.tokens_prompt_path
        else None
    )
    completion_tokens = (
        _coerce_int(_jsonpath_get(raw, ep.tokens_completion_path))
        if ep.tokens_completion_path
        else None
    )
    total_tokens = (
        _coerce_int(_jsonpath_get(raw, ep.tokens_total_path))
        if ep.tokens_total_path
        else None
    )

    return ChatbotEndpointTestResult(
        response_text=response_text,
        raw_response=raw,
        response_path_resolved=ep.response_path,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        latency_ms=latency_ms,
        error=err,
    )
