"""Shared client for calling a configured chatbot endpoint.

This is the single source of truth for:
  * rendering a request template (``{{question}}`` / ``{{messages}}`` / ``{{conversation}}``),
  * extracting fields from the JSON reply via a tiny ``$.a.b[0].c`` path, and
  * the actual HTTP call (``call_chatbot``).

Both ``api/chatbot_endpoints.py`` (the "Test connection" route) and
``api/datasets.py`` (the batch run worker) import from here, so a live REST
chatbot — OpenAI / Anthropic / Gemini / your own bot — is invoked the same way
everywhere.

Import-light by design: only the stdlib is imported at module load (``httpx`` is
imported lazily inside ``call_chatbot``; the ORM model is referenced only under
``TYPE_CHECKING``). That keeps the rendering/extraction core unit-testable
without installing the server's heavy ML dependencies.
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - typing only, never imported at runtime
    from .models import ChatbotEndpoint


# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------


def _build_messages(question: str, turns: list[Any] | None) -> list[dict[str, str]]:
    """Build an OpenAI/Anthropic-style ``[{role, content}]`` message list.

    ``turns`` (when given) is the full transcript and already ends with the
    user's latest message, so it is used verbatim. With no turns we synthesise a
    single user message from ``question``. Accepts turns as dicts or objects
    with ``.role`` / ``.content``.
    """
    if turns:
        out: list[dict[str, str]] = []
        for t in turns:
            if isinstance(t, dict):
                role = t.get("role") or "user"
                content = t.get("content") or ""
            else:
                role = getattr(t, "role", None) or "user"
                content = getattr(t, "content", "") or ""
            out.append({"role": str(role), "content": str(content)})
        if out:
            return out
    return [{"role": "user", "content": question}]


def render_request_template(
    template: str,
    *,
    question: str,
    turns: list[Any] | None = None,
) -> Any:
    """Render the placeholders in ``template`` and JSON-parse the result.

    Placeholders:
      * ``{{messages}}``     -> a JSON array of ``{role, content}`` (multi-turn aware)
      * ``{{question}}``     -> the latest user message (single-turn)
      * ``{{conversation}}`` -> alias of ``{{question}}`` (back-compat)

    ``{{messages}}`` is substituted as a raw JSON array literal (it sits where a
    JSON value is expected). The scalar placeholders are first tried raw, then
    JSON-escaped, so questions containing quotes/newlines still yield valid JSON.
    Falls back to the rendered string if it never parses.
    """
    messages_json = json.dumps(_build_messages(question, turns))

    raw = (
        template.replace("{{messages}}", messages_json)
        .replace("{{question}}", question)
        .replace("{{conversation}}", question)
    )
    try:
        return json.loads(raw)
    except Exception:
        escaped_scalar = json.dumps(question)[1:-1]  # strip the surrounding quotes
        safe = (
            template.replace("{{messages}}", messages_json)
            .replace("{{question}}", escaped_scalar)
            .replace("{{conversation}}", escaped_scalar)
        )
        try:
            return json.loads(safe)
        except Exception:
            return raw


# ---------------------------------------------------------------------------
# Response extraction
# ---------------------------------------------------------------------------


def jsonpath_get(payload: Any, path: str | None) -> Any:
    """Minimal ``$.a.b.c`` / ``$.a[0].b`` dot-and-bracket extractor.

    Returns ``None`` if any step misses. Deferred: filters, wildcards, recursive
    descent.
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


def coerce_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def extract_reply_text(data: Any, response_path: str | None) -> str | None:
    """Pull the reply text out of a parsed JSON response.

    Non-string leaves (e.g. a content array) are JSON-serialised so the caller
    always gets a string or ``None``.
    """
    val = jsonpath_get(data, response_path or "$.response")
    if val is None:
        return None
    return val if isinstance(val, str) else json.dumps(val)


def extract_tokens(
    data: Any,
    ep: "ChatbotEndpoint",
) -> tuple[int, int, int]:
    """``(prompt, completion, total)`` token counts; total defaults to p+c."""
    p = coerce_int(jsonpath_get(data, ep.tokens_prompt_path)) or 0
    c = coerce_int(jsonpath_get(data, ep.tokens_completion_path)) or 0
    t = coerce_int(jsonpath_get(data, ep.tokens_total_path)) or 0
    if t == 0:
        t = p + c
    return p, c, t


# ---------------------------------------------------------------------------
# HTTP call
# ---------------------------------------------------------------------------


async def call_chatbot(
    ep: "ChatbotEndpoint",
    *,
    question: str,
    turns: list[Any] | None = None,
) -> tuple[str | None, tuple[int, int, int]]:
    """Call a configured ``ChatbotEndpoint`` and return ``(reply_text, tokens)``.

    Raises ``httpx`` errors on transport/HTTP failures so callers can map them to
    their own error reporting. ``turns`` enables multi-turn replay.
    """
    import httpx  # lazy: keeps the rendering core importable without httpx

    body = render_request_template(ep.request_template, question=question, turns=turns)
    try:
        headers = json.loads(ep.headers_json or "{}")
        if not isinstance(headers, dict):
            headers = {}
    except Exception:
        headers = {}

    async with httpx.AsyncClient(timeout=float(ep.timeout_seconds or 30.0)) as client:
        resp = await client.request(
            (ep.method or "POST").upper(),
            ep.url,
            json=body if isinstance(body, (dict, list)) else None,
            content=None if isinstance(body, (dict, list)) else str(body),
            headers={"Content-Type": "application/json", **headers},
        )
        resp.raise_for_status()
        try:
            data = resp.json()
        except Exception:
            return resp.text, (0, 0, 0)

    return extract_reply_text(data, ep.response_path), extract_tokens(data, ep)


# ---------------------------------------------------------------------------
# Provider presets
# ---------------------------------------------------------------------------

# One-click starting points for common chat APIs. Stored as plain data so both
# the API route and the test suite can consume them. Users replace the
# ``<...API_KEY>`` placeholder in the headers after applying a preset.
PRESETS: list[dict[str, Any]] = [
    {
        "id": "openai",
        "label": "OpenAI",
        "description": (
            "Chat Completions API. Replace <OPENAI_API_KEY> in the headers. "
            "Multi-turn rows replay through {{messages}}."
        ),
        "method": "POST",
        "url": "https://api.openai.com/v1/chat/completions",
        "headers_json": '{\n  "Authorization": "Bearer <OPENAI_API_KEY>"\n}',
        "request_template": (
            '{\n  "model": "gpt-4o",\n  "messages": {{messages}},\n  "stream": false\n}'
        ),
        "response_path": "$.choices[0].message.content",
        "tokens_prompt_path": "$.usage.prompt_tokens",
        "tokens_completion_path": "$.usage.completion_tokens",
        "tokens_total_path": "$.usage.total_tokens",
    },
    {
        "id": "anthropic",
        "label": "Anthropic (Claude)",
        "description": (
            "Messages API. Replace <ANTHROPIC_API_KEY> in the headers. "
            "Multi-turn rows replay through {{messages}}."
        ),
        "method": "POST",
        "url": "https://api.anthropic.com/v1/messages",
        "headers_json": (
            '{\n  "x-api-key": "<ANTHROPIC_API_KEY>",\n'
            '  "anthropic-version": "2023-06-01"\n}'
        ),
        "request_template": (
            '{\n  "model": "claude-sonnet-4-6",\n  "max_tokens": 1024,\n'
            '  "messages": {{messages}}\n}'
        ),
        "response_path": "$.content[0].text",
        "tokens_prompt_path": "$.usage.input_tokens",
        "tokens_completion_path": "$.usage.output_tokens",
        "tokens_total_path": None,
    },
    {
        "id": "gemini",
        "label": "Google Gemini",
        "description": (
            "generateContent API — single-turn (the API key goes in the URL). "
            "Replace <GEMINI_API_KEY> in the URL."
        ),
        "method": "POST",
        "url": (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            "gemini-1.5-pro:generateContent?key=<GEMINI_API_KEY>"
        ),
        "headers_json": "{}",
        "request_template": (
            '{\n  "contents": [{ "parts": [{ "text": "{{question}}" }] }]\n}'
        ),
        "response_path": "$.candidates[0].content.parts[0].text",
        "tokens_prompt_path": "$.usageMetadata.promptTokenCount",
        "tokens_completion_path": "$.usageMetadata.candidatesTokenCount",
        "tokens_total_path": "$.usageMetadata.totalTokenCount",
    },
    {
        "id": "custom",
        "label": "Custom (blank)",
        "description": "A blank starting point — point it at your own bot's HTTP API.",
        "method": "POST",
        "url": "https://your-bot.example.com/chat",
        "headers_json": "{}",
        "request_template": '{ "question": "{{question}}" }',
        "response_path": "$.response",
        "tokens_prompt_path": None,
        "tokens_completion_path": None,
        "tokens_total_path": None,
    },
]
