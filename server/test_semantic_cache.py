"""Smoke test for the semantic reference cache.

Runs the get_or_create_reference flow end-to-end against an in-memory
SQLite DB and an isolated on-disk Chroma path, mocking the LLM call.

Verifies:
  1. First call → miss (generates), reference is upserted into refcache
  2. Identical call → exact-hash hit (cached=True, semantic_similarity=None)
  3. Paraphrase (≥ threshold) → semantic hit (cached=True, similarity>=threshold)
  4. Unrelated question → miss (generates)
  5. Disabled flag → exact-hash only; paraphrase misses
  6. Stale-pointer recovery → row deleted, paraphrase regenerates

Run: uv run python test_semantic_cache.py
"""

from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path

# Isolate data dir BEFORE importing app modules so Settings picks it up.
_tmp = Path(tempfile.mkdtemp(prefix="evalbot_test_"))
import os

os.environ["DATA_DIR"] = str(_tmp)
os.environ["SEED_PROJECT_DISABLED"] = "true"

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.config import settings
from app.engines import rag
from app.engines.rag import Chunk, ReferenceResult
from app.models import ReferenceAnswer  # noqa: F401 - register table
from app.services import reference as ref_service


PROJECT_ID = "11111111-1111-1111-1111-111111111111"


# ---- Mocked LLM ------------------------------------------------------------

_gen_calls: list[str] = []


async def fake_generate_reference(*, project_id, question, guideline_texts, provider=None):
    _gen_calls.append(question)
    return ReferenceResult(
        answer=f"ANSWER for: {question}",
        retrieved_chunks=[Chunk(text="snippet", source="doc.md", score=0.9)],
        prompt_tokens=10,
        completion_tokens=20,
        total_tokens=30,
    )


rag.generate_reference = fake_generate_reference  # type: ignore[assignment]


# ---- DB setup --------------------------------------------------------------


def make_session() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


# ---- Assertions helpers ----------------------------------------------------


PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
failures: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  {PASS}  {label}")
    else:
        print(f"  {FAIL}  {label}  {detail}")
        failures.append(label)


# ---- Tests -----------------------------------------------------------------


async def run() -> None:
    print(f"Tmp data dir: {_tmp}")
    print(f"Semantic cache enabled: {settings.REFERENCE_SEMANTIC_CACHE_ENABLED}")
    print(f"Threshold: {settings.REFERENCE_SEMANTIC_CACHE_THRESHOLD}\n")

    session = make_session()

    print("[1] First call (miss → generate)")
    _gen_calls.clear()
    p1 = await ref_service.get_or_create_reference(
        session, PROJECT_ID, "How do I reset my password?"
    )
    check("generated (not cached)", p1.cached is False)
    check("LLM called exactly once", len(_gen_calls) == 1, f"calls={len(_gen_calls)}")
    check("semantic_similarity is None on miss", p1.semantic_similarity is None)
    check("answer body present", p1.row.answer.startswith("ANSWER for:"))
    ref_id_1 = p1.row.id

    print("\n[2] Identical question (exact-hash hit)")
    _gen_calls.clear()
    p2 = await ref_service.get_or_create_reference(
        session, PROJECT_ID, "How do I reset my password?"
    )
    check("cached=True", p2.cached is True)
    check("no LLM call", len(_gen_calls) == 0)
    check("same row id", p2.row.id == ref_id_1)
    check("exact hit reports no semantic similarity", p2.semantic_similarity is None)

    print("\n[3] Paraphrased question (semantic hit expected)")
    # Probe raw similarity for tuning visibility.
    probe = await rag.find_similar_reference(PROJECT_ID, "How can I change my password?", 0.0)
    print(f"    probe similarity = {probe[1] if probe else 'n/a'}")
    _gen_calls.clear()
    p3 = await ref_service.get_or_create_reference(
        session, PROJECT_ID, "How can I change my password?"
    )
    check("cached=True", p3.cached is True, f"cached={p3.cached}")
    check("no LLM call", len(_gen_calls) == 0, f"calls={len(_gen_calls)}")
    check(
        "points to original row",
        p3.row.id == ref_id_1,
        f"got={p3.row.id} expected={ref_id_1}",
    )
    check(
        "semantic_similarity recorded",
        p3.semantic_similarity is not None
        and p3.semantic_similarity >= settings.REFERENCE_SEMANTIC_CACHE_THRESHOLD,
        f"sim={p3.semantic_similarity}",
    )

    print("\n[4] Unrelated question (miss → generate)")
    _gen_calls.clear()
    p4 = await ref_service.get_or_create_reference(
        session, PROJECT_ID, "What is the refund policy for enterprise plans?"
    )
    check("cached=False", p4.cached is False)
    check("LLM called", len(_gen_calls) == 1, f"calls={len(_gen_calls)}")
    check("different row id", p4.row.id != ref_id_1)

    print("\n[5] Disabled flag — paraphrase should miss")
    settings.REFERENCE_SEMANTIC_CACHE_ENABLED = False
    _gen_calls.clear()
    p5 = await ref_service.get_or_create_reference(
        session, PROJECT_ID, "How might I update the password on my account?"
    )
    check("cached=False when disabled", p5.cached is False)
    check("LLM called when disabled", len(_gen_calls) == 1)
    settings.REFERENCE_SEMANTIC_CACHE_ENABLED = True

    print("\n[6] Stale pointer recovery — delete row, paraphrase regenerates")
    # Delete the original row but leave it in the Chroma refcache.
    session.delete(session.get(ReferenceAnswer, ref_id_1))
    session.commit()
    _gen_calls.clear()
    p6 = await ref_service.get_or_create_reference(
        session, PROJECT_ID, "Help me set a new password please"
    )
    check("regenerates after stale hit", p6.cached is False)
    check("LLM called", len(_gen_calls) == 1)
    # Confirm the stale entry was purged: same paraphrase a second time should
    # now semantic-hit the FRESH row we just created.
    _gen_calls.clear()
    p6b = await ref_service.get_or_create_reference(
        session, PROJECT_ID, "Help me set a new password please"
    )
    check("exact-hash hit on repeat", p6b.cached is True and len(_gen_calls) == 0)

    print()
    if failures:
        print(f"{FAIL} {len(failures)} check(s) failed: {failures}")
        sys.exit(1)
    print(f"{PASS} all checks passed")


def main() -> None:
    try:
        asyncio.run(run())
    finally:
        shutil.rmtree(_tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
