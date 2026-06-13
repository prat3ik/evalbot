from __future__ import annotations

import asyncio

from ...config import settings
from . import JudgeResult, JudgeTimeoutError, MissingProviderCredentialsError, TokenUsage
from ._prompt import JUDGE_SYSTEM, build_judge_prompt, parse_judge_json

DEFAULT_MODEL = "gemini-1.5-pro"


class GeminiJudge:
    name = "gemini"

    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        self.api_key = api_key or settings.GEMINI_API_KEY
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
                "Gemini judge requires GEMINI_API_KEY to be set in the environment."
            )

        import google.generativeai as genai

        prompt = build_judge_prompt(
            question,
            response,
            reference,
            guidelines,
            prior_context=prior_context,
            custom_checks=custom_checks,
        )
        check_ids = [str(c.get("id", "")) for c in (custom_checks or []) if c.get("id")]

        def _call() -> tuple[str, TokenUsage]:
            genai.configure(api_key=self.api_key)
            model = genai.GenerativeModel(
                self.model,
                system_instruction=JUDGE_SYSTEM,
                generation_config={"response_mime_type": "application/json"},
            )
            result = model.generate_content(prompt)
            text = getattr(result, "text", "") or ""
            usage = TokenUsage()
            try:
                meta = getattr(result, "usage_metadata", None)
                if meta is not None:
                    usage = TokenUsage.of(
                        getattr(meta, "prompt_token_count", 0),
                        getattr(meta, "candidates_token_count", 0),
                        getattr(meta, "total_token_count", None),
                    )
            except Exception:
                pass
            return text, usage

        try:
            raw, usage = await asyncio.wait_for(
                asyncio.to_thread(_call),
                timeout=settings.JUDGE_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            raise JudgeTimeoutError(
                f"Gemini judge timed out after {settings.JUDGE_TIMEOUT_SECONDS}s"
            ) from exc
        result = parse_judge_json(
            raw, provider=self.name, model=self.model, custom_check_ids=check_ids
        )
        result.usage = usage
        return result


async def chat(prompt: str) -> tuple[str, TokenUsage]:
    """Single-turn completion via Google Gemini."""
    api_key = settings.GEMINI_API_KEY
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set; cannot call Gemini provider.")

    import google.generativeai as genai

    def _call() -> tuple[str, TokenUsage]:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(DEFAULT_MODEL)
        result = model.generate_content(prompt)
        text = (getattr(result, "text", "") or "").strip()
        usage = TokenUsage()
        try:
            meta = getattr(result, "usage_metadata", None)
            if meta is not None:
                usage = TokenUsage.of(
                    getattr(meta, "prompt_token_count", 0),
                    getattr(meta, "candidates_token_count", 0),
                    getattr(meta, "total_token_count", None),
                )
        except Exception:
            pass
        return text, usage

    return await asyncio.to_thread(_call)
