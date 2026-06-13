from __future__ import annotations

from dataclasses import dataclass

# Default scoring weights from the README. They sum to 1.0.
DEFAULT_WEIGHTS: dict[str, float] = {
    "similarity": 0.35,
    "accuracy": 0.25,
    "completeness": 0.25,
    "relevance": 0.10,
    "readability": 0.05,
}


@dataclass
class DimensionScores:
    similarity: float = 0.0
    accuracy: float = 0.0
    completeness: float = 0.0
    relevance: float = 0.0
    readability: float = 0.0

    def as_dict(self) -> dict[str, float]:
        return {
            "similarity": self.similarity,
            "accuracy": self.accuracy,
            "completeness": self.completeness,
            "relevance": self.relevance,
            "readability": self.readability,
        }


def combine(
    scores: DimensionScores | dict[str, float],
    weights: dict[str, float] | None = None,
) -> float:
    """Weighted sum of the five dimensions.

    Computes a straight weighted sum using the fixed README weights
    (35/25/25/10/5, summing to 1.0). Missing metrics are treated as 0;
    weights are NOT renormalized by present-metric total.

        combined = 0.35*similarity + 0.25*accuracy + 0.25*completeness
                 + 0.10*relevance  + 0.05*readability
    """
    w = weights or DEFAULT_WEIGHTS
    s = scores.as_dict() if isinstance(scores, DimensionScores) else scores
    return sum(s.get(k, 0.0) * w.get(k, 0.0) for k in w)


def combine_judge(result, weights: dict[str, float] | None = None) -> float:
    """Combined AI score from a JudgeResult, using the same 5-dim formula as
    the ML side.

    Readability handling: the AI judge does NOT compute Flesch-Kincaid
    readability — that's the ML/NLP engine's job. JudgeResult.readability is
    populated with a neutral 80.0 in the parser so the 5-dim weighted sum can
    be applied identically here. (The alternative — mapping
    factual_consistency into the readability slot — would conflate two
    different signals; the neutral-default approach keeps the AI score
    comparable to the ML score on the same scale without skew.)
    """
    scores = {
        "similarity": getattr(result, "similarity", 0.0),
        "accuracy": getattr(result, "accuracy", 0.0),
        "completeness": getattr(result, "completeness", 0.0),
        "relevance": getattr(result, "relevance", 0.0),
        "readability": getattr(result, "readability", 80.0) or 80.0,
    }
    return combine(scores, weights)


def is_refusal_case(judge_result, ml_result) -> bool:
    """True when the AI judge has flagged this as a correct refusal scenario.

    Requires BOTH signals: judge says refusal is appropriate (>=90) AND ML's
    refusal sub-metric fired (>=50, which is 100 when a refusal phrase is
    detected by the ML engine).
    """
    if judge_result is None:
        return False
    judge_refusal_ok = (getattr(judge_result, "refusal_appropriateness", 0) or 0) >= 90
    ml_refusal_fired = False
    if ml_result is not None:
        sub = getattr(ml_result, "sub_metrics", None) or {}
        refusal_sub = sub.get("refusal", {}) if isinstance(sub, dict) else {}
        ml_refusal_fired = (refusal_sub.get("value") or 0) >= 50
    return judge_refusal_ok and ml_refusal_fired


def combine_judge_refusal_mode(result) -> float:
    """Refusal-mode AI combined: 0.5*relevance + 0.3*refusal_appropriateness + 0.2*accuracy."""
    relevance = float(getattr(result, "relevance", 0.0) or 0.0)
    refusal_appr = float(getattr(result, "refusal_appropriateness", 0.0) or 0.0)
    accuracy = float(getattr(result, "accuracy", 0.0) or 0.0)
    return 0.5 * relevance + 0.3 * refusal_appr + 0.2 * accuracy


def combine_ml_refusal_mode(ml_result) -> float:
    """Refusal-mode ML combined: 0.6*readability + 0.4*relevance.

    Textual similarity/accuracy/completeness are meaningless when the bot
    correctly refuses with terse phrasing — de-weight them.
    """
    readability = float(getattr(ml_result, "readability", 0.0) or 0.0)
    relevance = float(getattr(ml_result, "relevance", 0.0) or 0.0)
    return 0.6 * readability + 0.4 * relevance


def final_score(ml_score: float | None, ai_score: float | None) -> float | None:
    """Average ml & ai scores when both present; otherwise return whichever ran."""
    if ml_score is not None and ai_score is not None:
        return (ml_score + ai_score) / 2
    if ml_score is not None:
        return ml_score
    if ai_score is not None:
        return ai_score
    return None
