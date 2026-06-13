from __future__ import annotations

import asyncio

from ...config import settings
from . import JudgeResult, JudgeTimeoutError, MissingProviderCredentialsError, TokenUsage
from ._prompt import JUDGE_SYSTEM, build_judge_prompt, parse_judge_json

DEFAULT_MODEL = "gpt-4o"


class OpenAIJudge:
    name = "openai"

    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        self.api_key = api_key or settings.OPENAI_API_KEY
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
                "OpenAI judge requires OPENAI_API_KEY to be set in the environment."
            )

        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=self.api_key)
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
            completion = await asyncio.wait_for(
                client.chat.completions.create(
                    model=self.model,
                    response_format={"type": "json_object"},
                    messages=[
                        {"role": "system", "content": JUDGE_SYSTEM},
                        {"role": "user", "content": prompt},
                    ],
                ),
                timeout=settings.JUDGE_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            raise JudgeTimeoutError(
                f"OpenAI judge timed out after {settings.JUDGE_TIMEOUT_SECONDS}s"
            ) from exc
        raw = completion.choices[0].message.content or ""
        result = parse_judge_json(
            raw, provider=self.name, model=self.model, custom_check_ids=check_ids
        )
        try:
            u = getattr(completion, "usage", None)
            if u is not None:
                result.usage = TokenUsage.of(
                    getattr(u, "prompt_tokens", 0),
                    getattr(u, "completion_tokens", 0),
                    getattr(u, "total_tokens", None),
                )
        except Exception:
            result.usage = TokenUsage()
        return result


async def chat(prompt: str) -> tuple[str, TokenUsage]:
    """Single-turn completion via OpenAI Chat Completions."""
    api_key = settings.OPENAI_API_KEY
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set; cannot call OpenAI provider.")

    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=api_key)
    completion = await client.chat.completions.create(
        model=DEFAULT_MODEL,
        messages=[{"role": "user", "content": prompt}],
    )
    choice = completion.choices[0]
    usage = TokenUsage()
    try:
        u = getattr(completion, "usage", None)
        if u is not None:
            usage = TokenUsage.of(
                getattr(u, "prompt_tokens", 0),
                getattr(u, "completion_tokens", 0),
                getattr(u, "total_tokens", None),
            )
    except Exception:
        pass
    return (choice.message.content or "").strip(), usage
