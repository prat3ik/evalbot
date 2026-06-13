from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

Severity = Literal["minor", "major", "critical"]


@dataclass
class TokenUsage:
    """Token counts captured from an LLM SDK response.

    Zeros indicate "unavailable" — providers that don't report usage (or
    where the SDK field was missing) fall back to 0 rather than crashing.
    """

    prompt: int = 0
    completion: int = 0
    total: int = 0

    @classmethod
    def of(cls, prompt: int | None, completion: int | None, total: int | None = None) -> "TokenUsage":
        p = int(prompt or 0)
        c = int(completion or 0)
        t = int(total) if total is not None else p + c
        return cls(prompt=p, completion=c, total=t)


@dataclass
class JudgeFinding:
    guideline_excerpt: str  # the rule that was violated, quoted
    offending_span: str  # the chatbot response excerpt that violated it
    reason: str  # one-line explanation
    severity: Severity | None = None


# CUSTOM_CHECKS_DISABLED — dataclass + JudgeResult.custom_check_results field
# are kept so callers don't break. They default to empty and are never
# populated while the feature is disabled.
@dataclass
class CustomCheckResult:
    """One per-check result from the AI judge when custom checks are wired in.

    ``id`` matches the CustomCheck.id passed into the prompt. ``score`` is on
    a 0-100 scale to match the standard dimensions, ``passed`` is a boolean
    summary, and ``reason`` is the model's short explanation (shown inline
    in the UI tile).
    """

    id: str
    score: float = 0.0
    passed: bool = False
    reason: str = ""


@dataclass
class JudgeResult:
    # Per-dimension 0-100 scores produced by the AI judge.
    similarity: float = 0.0
    accuracy: float = 0.0
    completeness: float = 0.0
    relevance: float = 0.0
    readability: float = 0.0
    factual_consistency: float = 0.0
    numeric_consistency: float = 0.0
    refusal_appropriateness: float = 0.0

    rationale: str = ""
    findings: list[JudgeFinding] = field(default_factory=list)
    custom_check_results: list[CustomCheckResult] = field(default_factory=list)
    provider: str = ""
    model: str | None = None
    raw_response: str = ""
    usage: TokenUsage | None = None


class JudgeError(Exception):
    """Base class for judge errors."""


class JudgeParseError(JudgeError):
    """Raised when the model output cannot be parsed as the expected JudgeResult JSON."""

    def __init__(self, message: str, raw_response: str = "") -> None:
        super().__init__(message)
        self.raw_response = raw_response


class MissingProviderCredentialsError(JudgeError):
    """Raised when the required API key / base URL for a provider is missing."""


class JudgeTimeoutError(JudgeError):
    """Raised when an AI judge network call exceeds JUDGE_TIMEOUT_SECONDS."""


@runtime_checkable
class JudgeProvider(Protocol):
    name: str

    async def judge(
        self,
        question: str,
        response: str,
        reference: str,
        guidelines: list[str],
        prior_context: str | None = None,
        custom_checks: list[dict] | None = None,
    ) -> JudgeResult: ...
