from __future__ import annotations

from collections.abc import Callable

from ..config import settings
from .judges import JudgeProvider, JudgeResult, MissingProviderCredentialsError, TokenUsage
from .judges.anthropic import AnthropicJudge
from .judges.gemini import GeminiJudge
from .judges.ollama import OllamaJudge
from .judges.openai import OpenAIJudge

PROVIDERS: dict[str, Callable[[], JudgeProvider]] = {
    "anthropic": lambda: AnthropicJudge(),
    "gemini": lambda: GeminiJudge(),
    "openai": lambda: OpenAIJudge(),
    "ollama": lambda: OllamaJudge(),
}


# Env var each provider depends on; used for the defensive missing-creds check.
_PROVIDER_ENV_VAR: dict[str, str] = {
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "ollama": "OLLAMA_BASE_URL",
}


def list_providers() -> list[str]:
    """Return the names of all registered judge providers."""
    return list(PROVIDERS.keys())


def _check_credentials(name: str) -> None:
    """Raise MissingProviderCredentialsError if the configured provider has no
    credentials. The provider's own judge() also guards this, but failing fast
    here gives a friendlier message before any SDK is imported."""
    env_var = _PROVIDER_ENV_VAR.get(name)
    if not env_var:
        return
    value = getattr(settings, env_var, "")
    if not value:
        raise MissingProviderCredentialsError(
            f"AI judge provider '{name}' requires the environment variable "
            f"'{env_var}' to be set. Add it to your .env file."
        )


async def judge(
    question: str,
    response: str,
    reference: str,
    guidelines: list[str],
    provider: str | None = None,
    prior_context: str | None = None,
    custom_checks: list[dict] | None = None,
) -> JudgeResult:
    """Dispatch to the configured (or requested) AI judge provider."""
    name = (provider or settings.AI_JUDGE_PROVIDER or "").lower()
    if name not in PROVIDERS:
        raise ValueError(
            f"Unknown AI judge provider '{name}'. Available providers: {sorted(PROVIDERS)}"
        )
    _check_credentials(name)
    return await PROVIDERS[name]().judge(
        question,
        response,
        reference,
        guidelines,
        prior_context=prior_context,
        custom_checks=custom_checks,
    )


class AIJudgeDispatcher:
    """Object-style wrapper around the module-level dispatcher; kept for
    callers that prefer dependency-injected instances."""

    def __init__(self, default_provider: str | None = None) -> None:
        self.default_provider = default_provider or settings.AI_JUDGE_PROVIDER

    def get_provider(self, name: str | None = None) -> JudgeProvider:
        key = (name or self.default_provider or "").lower()
        if key not in PROVIDERS:
            raise ValueError(
                f"Unknown AI judge provider '{key}'. Available providers: {sorted(PROVIDERS)}"
            )
        return PROVIDERS[key]()

    async def judge(
        self,
        question: str,
        chatbot_response: str,
        reference_answer: str,
        guidelines: list[str],
        provider: str | None = None,
        prior_context: str | None = None,
        custom_checks: list[dict] | None = None,
    ) -> JudgeResult:
        return await judge(
            question,
            chatbot_response,
            reference_answer,
            guidelines,
            provider or self.default_provider,
            prior_context=prior_context,
            custom_checks=custom_checks,
        )


async def chat(prompt: str, provider: str | None = None) -> tuple[str, TokenUsage]:
    """Generic single-turn completion via the configured provider.

    Returns ``(text, usage)`` so callers can persist token counts alongside
    the generated text. Uses the same provider-name resolution as
    ``judge()`` so a single ``AI_JUDGE_PROVIDER`` setting drives both code
    paths. Raises a clear error if the requested provider's API key / config
    is missing.
    """
    name = (provider or settings.AI_JUDGE_PROVIDER or "").lower()
    if name not in PROVIDERS:
        raise ValueError(f"Unknown AI provider '{name}'. Available providers: {sorted(PROVIDERS)}")
    _check_credentials(name)

    if name == "anthropic":
        from .judges import anthropic as mod
    elif name == "gemini":
        from .judges import gemini as mod
    elif name == "openai":
        from .judges import openai as mod
    elif name == "ollama":
        from .judges import ollama as mod
    else:  # pragma: no cover - guarded by PROVIDERS check above
        raise ValueError(f"Unknown AI provider: {name!r}")

    return await mod.chat(prompt)
