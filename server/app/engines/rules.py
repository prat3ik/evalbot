"""Guideline / rule checking is performed by the AI judge.

The judge reads the raw guideline `.md` files verbatim as part of its prompt
and returns a list of ``JudgeFinding`` entries (guideline_excerpt,
offending_span, reason, severity). See ``engines/judges/_prompt.py`` for the
prompt and the schema, and ``engines/judges/__init__.py`` for ``JudgeFinding``.

This module is intentionally empty in MVP. It exists as a placeholder for
optional deterministic policy checks layered on top of the AI judge in a
future phase.
"""
