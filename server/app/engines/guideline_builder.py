"""Generate Company Guideline markdown files from a project's ingested content.

Reads up to N chunks from the project's Chroma collection, asks the AI to write
structured guideline documents, then materializes them as GuidelineFile rows on
disk in the project's guidelines directory. Streams progress as SSE events.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..config import settings
from .rag import _get_or_create_collection


@dataclass
class BuildEvent:
    type: str  # "status" | "file" | "done" | "error"
    payload: dict[str, Any]


SECTIONS: list[tuple[str, str]] = [
    (
        "product-overview.md",
        "Product overview & scope",
        "What the product is, who it's for, what it does and explicitly does NOT do. "
        "Pull supported platforms, integrations, and product surface area from the docs. "
        "Skip marketing fluff.",
    ),
    (
        "support-policy.md",
        "Support policy & tone",
        "How a support bot should behave: tone of voice, escalation rules, what topics "
        "it must refuse or defer (legal, billing, account changes), how it should respond "
        "to unsafe / off-topic / harmful requests. Cite specific policies from the docs.",
    ),
    (
        "facts-and-limits.md",
        "Key facts, limits & defaults",
        "Hard facts that answers MUST cite verbatim: pricing, plan limits, rate limits, "
        "default behavior, supported file types, retention windows, parameter ranges. "
        "Preserve exact numbers and product terminology.",
    ),
    (
        "faq.md",
        "Common questions & canonical answers",
        "5-12 questions a user is likely to ask, each with a 1-3 sentence canonical "
        "answer grounded in the docs. Use the page's own wording where possible.",
    ),
]


BUILD_PROMPT = """You are an expert technical writer producing a "{section_title}"
markdown document for a chatbot evaluation project. The document will be read
VERBATIM by an AI judge as ground truth when scoring chatbot answers.

Section goal:
{section_brief}

Use ONLY the source excerpts below. Do NOT invent facts. If a fact isn't in the
excerpts, omit it rather than guess.

SOURCE EXCERPTS (each starts with its source URL):
---
{excerpts}
---

Write the markdown now. Rules:
- Start with `# {section_title}`.
- Use short bullets and tight paragraphs.
- Preserve exact numbers, names, and product terms.
- Inline source URLs in parentheses where a fact comes from a specific page,
  e.g. "Free plan: 100 runs/month (https://docs.example.com/pricing)".
- If the excerpts don't contain enough material for this section, output only:
  "(insufficient source material)" — no preamble, no apology.
"""


def _gather_excerpts(project_id: str, limit: int = 60) -> list[dict[str, str]]:
    """Pull up to `limit` chunks (with source url) from the project's Chroma collection."""
    collection = _get_or_create_collection(project_id)
    try:
        res = collection.get(limit=limit, include=["documents", "metadatas"])
    except Exception:
        return []
    docs: list[str] = list(res.get("documents") or [])
    metas: list[dict[str, Any]] = list(res.get("metadatas") or [])
    out: list[dict[str, str]] = []
    for i, text in enumerate(docs):
        meta = metas[i] if i < len(metas) else {}
        source = str(meta.get("url") or meta.get("source") or meta.get("filename") or "")
        out.append({"source": source, "text": str(text)})
    return out


def _format_excerpts(excerpts: list[dict[str, str]], max_chars: int = 18000) -> str:
    """Pack source-tagged excerpts into a single string under a char budget."""
    pieces: list[str] = []
    used = 0
    for ex in excerpts:
        source = ex["source"] or "(unknown source)"
        block = f"\n\n# Source: {source}\n{ex['text']}"
        if used + len(block) > max_chars:
            break
        pieces.append(block)
        used += len(block)
    return "".join(pieces).strip() or "(no source material)"


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9._-]+", "-", name).strip("-").lower()
    return s or "guideline.md"


def _save_guideline(project_id: str, filename: str, content: str):
    from sqlmodel import Session, select

    from ..db import engine
    from ..models import GuidelineFile

    g_dir = settings.projects_path / project_id / "guidelines"
    g_dir.mkdir(parents=True, exist_ok=True)
    safe = _slugify(filename)
    if not safe.endswith(".md"):
        safe += ".md"
    dest = g_dir / safe
    # Avoid clobbering a user's existing file with the same name.
    if dest.exists():
        stem = dest.stem
        i = 2
        while True:
            cand = g_dir / f"{stem}-{i}.md"
            if not cand.exists():
                dest = cand
                break
            i += 1
    dest.write_text(content, encoding="utf-8")

    with Session(engine) as session:
        existing = session.exec(
            select(GuidelineFile)
            .where(GuidelineFile.project_id == project_id)
            .where(GuidelineFile.filename == dest.name)
        ).first()
        if existing is None:
            gf = GuidelineFile(
                project_id=project_id,
                filename=dest.name,
                path=str(dest.resolve()),
                content=content,
                uploaded_at=datetime.utcnow(),
            )
            session.add(gf)
            session.commit()
            session.refresh(gf)
            return gf
        existing.content = content
        existing.path = str(dest.resolve())
        existing.uploaded_at = datetime.utcnow()
        session.add(existing)
        session.commit()
        session.refresh(existing)
        return existing


async def build_guidelines_stream(
    project_id: str, provider: str | None = None
) -> AsyncIterator[BuildEvent]:
    """Yield progress events while AI builds Company Guidelines for the project."""
    from . import ai

    yield BuildEvent("status", {"message": "Reading indexed documents…"})
    excerpts = _gather_excerpts(project_id, limit=80)
    if not excerpts:
        yield BuildEvent(
            "error",
            {"message": "No indexed content yet — ingest documents or a URL first."},
        )
        return

    formatted = _format_excerpts(excerpts)
    yield BuildEvent(
        "status",
        {"message": f"Drafting {len(SECTIONS)} guideline files from {len(excerpts)} excerpts…"},
    )

    produced = 0
    for filename, section_title, section_brief in SECTIONS:
        yield BuildEvent(
            "status",
            {"message": f"Drafting {section_title}…"},
        )
        prompt = BUILD_PROMPT.format(
            section_title=section_title,
            section_brief=section_brief,
            excerpts=formatted,
        )
        try:
            answer, _usage = await ai.chat(prompt, provider=provider)
        except Exception as exc:
            yield BuildEvent(
                "file",
                {
                    "filename": filename,
                    "title": section_title,
                    "status": "failed",
                    "error": f"{type(exc).__name__}: {exc}",
                },
            )
            continue

        answer = (answer or "").strip()
        if (
            not answer
            or "insufficient source material" in answer.lower()
            or len(answer) < 60
        ):
            yield BuildEvent(
                "file",
                {
                    "filename": filename,
                    "title": section_title,
                    "status": "skipped",
                    "reason": "not enough source material",
                },
            )
            continue

        try:
            gf = _save_guideline(project_id, filename, answer)
        except Exception as exc:
            yield BuildEvent(
                "file",
                {
                    "filename": filename,
                    "title": section_title,
                    "status": "failed",
                    "error": f"{type(exc).__name__}: {exc}",
                },
            )
            continue

        produced += 1
        yield BuildEvent(
            "file",
            {
                "filename": gf.filename,
                "guideline_id": gf.id,
                "title": section_title,
                "status": "saved",
                "size": len(answer),
            },
        )

    yield BuildEvent(
        "done",
        {"files_saved": produced, "files_attempted": len(SECTIONS)},
    )
