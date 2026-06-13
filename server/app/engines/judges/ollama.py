from __future__ import annotations

import asyncio
import os

import httpx

from ...config import settings
from . import JudgeResult, JudgeTimeoutError, MissingProviderCredentialsError, TokenUsage
from ._prompt import JUDGE_SYSTEM, build_judge_prompt, parse_judge_json

DEFAULT_MODEL = os.getenv("OLLAMA_MODEL", "llama3")


class OllamaJudge:
    name = "ollama"

    def __init__(self, base_url: str | None = None, model: str | None = None) -> None:
        self.base_url = (base_url or settings.OLLAMA_BASE_URL or "").rstrip("/")
        self.model = model or os.getenv("OLLAMA_MODEL", "llama3")

    async def judge(
        self,
        question: str,
        response: str,
        reference: str,
        guidelines: list[str],
        prior_context: str | None = None,
        custom_checks: list[dict] | None = None,
    ) -> JudgeResult:
        if not self.base_url:
            raise MissingProviderCredentialsError(
                "Ollama judge requires OLLAMA_BASE_URL to be set (e.g. http://localhost:11434)."
            )

        prompt = build_judge_prompt(
            question,
            response,
            reference,
            guidelines,
            prior_context=prior_context,
            custom_checks=custom_checks,
        )
        check_ids = [str(c.get("id", "")) for c in (custom_checks or []) if c.get("id")]
        payload = {
            "model": self.model,
            "format": "json",
            "stream": False,
            "messages": [
                {"role": "system", "content": JUDGE_SYSTEM},
                {"role": "user", "content": prompt},
            ],
        }

        async def _do_request() -> dict:
            async with httpx.AsyncClient(timeout=120.0) as client:
                r = await client.post(f"{self.base_url}/api/chat", json=payload)
                r.raise_for_status()
                return r.json()

        try:
            data = await asyncio.wait_for(_do_request(), timeout=settings.JUDGE_TIMEOUT_SECONDS)
        except TimeoutError as exc:
            raise JudgeTimeoutError(
                f"Ollama judge timed out after {settings.JUDGE_TIMEOUT_SECONDS}s"
            ) from exc

        raw = ""
        if isinstance(data, dict):
            msg = data.get("message")
            if isinstance(msg, dict):
                raw = msg.get("content") or ""
        result = parse_judge_json(
            raw, provider=self.name, model=self.model, custom_check_ids=check_ids
        )
        try:
            if isinstance(data, dict):
                result.usage = TokenUsage.of(
                    data.get("prompt_eval_count") or 0,
                    data.get("eval_count") or 0,
                )
        except Exception:
            result.usage = TokenUsage()
        return result


async def chat(prompt: str) -> tuple[str, TokenUsage]:
    """Single-turn completion via a local Ollama server."""
    base_url = (settings.OLLAMA_BASE_URL or "").rstrip("/")
    if not base_url:
        raise RuntimeError("OLLAMA_BASE_URL is not set; cannot call Ollama provider.")

    payload = {
        "model": DEFAULT_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await client.post(f"{base_url}/api/chat", json=payload)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Ollama request failed: {exc}") from exc

    data = resp.json()
    message = data.get("message") or {}
    usage = TokenUsage()
    try:
        usage = TokenUsage.of(
            data.get("prompt_eval_count") or 0,
            data.get("eval_count") or 0,
        )
    except Exception:
        pass
    return (message.get("content") or "").strip(), usage
