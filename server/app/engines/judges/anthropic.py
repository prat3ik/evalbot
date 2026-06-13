from __future__ import annotations

import asyncio

from ...config import settings
from . import JudgeResult, JudgeTimeoutError, MissingProviderCredentialsError, TokenUsage
from ._prompt import JUDGE_SYSTEM, build_judge_prompt, parse_judge_json

DEFAULT_MODEL = "claude-sonnet-4-6"


class AnthropicJudge:
    name = "anthropic"

    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        self.api_key = api_key or settings.ANTHROPIC_API_KEY
        self.model = model or DEFAULT_MODEL

    async def judge(
        self,
        question: str,
        response: str,
        reference: str,
        guidelines: list[str],
        prior_context: str | None = None,
        custom_checks: list[dict] | None = None,
    ) -> JudgeResult:
        if not self.api_key:
            raise MissingProviderCredentialsError(
                "Anthropic judge requires ANTHROPIC_API_KEY to be set in the environment."
            )

        from anthropic import AsyncAnthropic

        client = AsyncAnthropic(api_key=self.api_key)
        prompt = build_judge_prompt(
            question,
            response,
            reference,
            guidelines,
            prior_context=prior_context,
            custom_checks=custom_checks,
        )
        check_ids = [str(c.get("id", "")) for c in (custom_checks or []) if c.get("id")]

        try:
            msg = await asyncio.wait_for(
                client.messages.create(
                    model=self.model,
                    max_tokens=2048,
                    system=JUDGE_SYSTEM,
                    messages=[{"role": "user", "content": prompt}],
                ),
                timeout=settings.JUDGE_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            raise JudgeTimeoutError(
                f"Anthropic judge timed out after {settings.JUDGE_TIMEOUT_SECONDS}s"
            ) from exc

        parts: list[str] = []
        for block in getattr(msg, "content", []) or []:
            text = getattr(block, "text", None)
            if text:
                parts.append(text)
        raw = "".join(parts)
        result = parse_judge_json(
            raw, provider=self.name, model=self.model, custom_check_ids=check_ids
        )
        try:
            usage = getattr(msg, "usage", None)
            if usage is not None:
                result.usage = TokenUsage.of(
                    getattr(usage, "input_tokens", 0),
                    getattr(usage, "output_tokens", 0),
                )
        except Exception:
            result.usage = TokenUsage()
        return result


async def chat(prompt: str) -> tuple[str, TokenUsage]:
    """Single-turn completion via the Anthropic Messages API."""
    api_key = settings.ANTHROPIC_API_KEY
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set; cannot call Anthropic provider.")

    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=api_key)
    message = await client.messages.create(
        model=DEFAULT_MODEL,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )

    parts: list[str] = []
    for block in message.content:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    usage = TokenUsage()
    try:
        u = getattr(message, "usage", None)
        if u is not None:
            usage = TokenUsage.of(
                getattr(u, "input_tokens", 0), getattr(u, "output_tokens", 0)
            )
    except Exception:
        pass
    return "".join(parts).strip(), usage
