"""Ingest documentation from a URL into the project's Chroma collection.

Strategy:
  1. Try the site's sitemap (sitemap.xml / sitemap_index.xml). If found, take up
     to `max_pages` URLs on the same host.
  2. Otherwise fall back to a same-domain BFS crawl from the seed URL.
  3. For each page: prefer Mintlify-style `<path>.md` (clean markdown), else
     extract main content with trafilatura.
  4. Chunk + embed each page into the project's existing Chroma collection,
     emitting progress events as we go.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

from .rag import _chunk_text, _get_or_create_collection

USER_AGENT = "EvalBot/0.1 (+https://github.com/) docs ingestion"

# Aggressive but polite: enough to fetch ~20 pages in a few seconds without
# tripping basic rate limits on a static docs CDN.
REQUEST_TIMEOUT = 15.0
PER_REQUEST_DELAY = 0.05

# Sitemap probe order. Most static docs sites publish at least one of these.
SITEMAP_CANDIDATES = ("/sitemap.xml", "/sitemap_index.xml", "/sitemap-0.xml")


@dataclass
class IngestEvent:
    """Single SSE-bound progress event."""

    type: str  # "status" | "page" | "done" | "error"
    payload: dict[str, Any]


# ---------------------------------------------------------------------------
# URL helpers
# ---------------------------------------------------------------------------


def _normalize_url(url: str) -> str:
    parsed = urlparse(url.strip())
    if not parsed.scheme:
        parsed = parsed._replace(scheme="https")
    # Drop fragment; keep path/query as-is.
    return urlunparse(parsed._replace(fragment=""))


def _same_host(a: str, b: str) -> bool:
    return urlparse(a).netloc.lower() == urlparse(b).netloc.lower()


def _origin(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


# ---------------------------------------------------------------------------
# Sitemap discovery
# ---------------------------------------------------------------------------


_LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.IGNORECASE)


async def _fetch_text(client: httpx.AsyncClient, url: str) -> tuple[int, str, str]:
    """Return (status_code, content_type, text). Never raises on HTTP errors."""
    try:
        resp = await client.get(url, follow_redirects=True, timeout=REQUEST_TIMEOUT)
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        return (0, "", f"fetch error: {exc}")
    ct = resp.headers.get("content-type", "")
    return (resp.status_code, ct, resp.text)


async def _discover_sitemap_urls(
    client: httpx.AsyncClient, seed: str, max_pages: int
) -> list[str]:
    """Try sitemap candidates. Return a list of same-host page URLs (deduped)."""
    origin = _origin(seed)
    found: list[str] = []
    seen: set[str] = set()

    candidates = [origin + path for path in SITEMAP_CANDIDATES]
    # robots.txt may declare a `Sitemap:` directive — check it too.
    status, _, body = await _fetch_text(client, origin + "/robots.txt")
    if status == 200:
        for line in body.splitlines():
            line = line.strip()
            if line.lower().startswith("sitemap:"):
                candidates.append(line.split(":", 1)[1].strip())

    for sm_url in candidates:
        status, _, text = await _fetch_text(client, sm_url)
        if status != 200 or "<loc>" not in text.lower():
            continue
        for match in _LOC_RE.findall(text):
            loc = match.strip()
            # Sitemap index? Follow one level deep.
            if loc.lower().endswith(".xml"):
                status2, _, text2 = await _fetch_text(client, loc)
                if status2 == 200:
                    for sub in _LOC_RE.findall(text2):
                        sub = sub.strip()
                        if not _same_host(sub, seed) or sub in seen:
                            continue
                        seen.add(sub)
                        found.append(sub)
                        if len(found) >= max_pages:
                            return found
                continue
            if not _same_host(loc, seed) or loc in seen:
                continue
            seen.add(loc)
            found.append(loc)
            if len(found) >= max_pages:
                return found
        if found:
            return found
    return found


# ---------------------------------------------------------------------------
# Fallback crawler (BFS, same-host, depth 1-2)
# ---------------------------------------------------------------------------


_HREF_RE = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)


async def _bfs_crawl(client: httpx.AsyncClient, seed: str, max_pages: int) -> list[str]:
    queue: list[str] = [seed]
    visited: set[str] = set()
    out: list[str] = []
    while queue and len(out) < max_pages:
        url = queue.pop(0)
        if url in visited:
            continue
        visited.add(url)
        status, ct, body = await _fetch_text(client, url)
        if status != 200 or "html" not in ct.lower():
            continue
        out.append(url)
        for href in _HREF_RE.findall(body):
            absolute = urljoin(url, href).split("#", 1)[0]
            if not absolute.startswith(("http://", "https://")):
                continue
            if not _same_host(absolute, seed):
                continue
            if absolute in visited or absolute in queue:
                continue
            queue.append(absolute)
        await asyncio.sleep(PER_REQUEST_DELAY)
    return out


# ---------------------------------------------------------------------------
# Content extraction
# ---------------------------------------------------------------------------


# Mintlify/Docusaurus/MDX pages embed JSX-like components (<Note>, <Callout>,
# <Card>, <CodeGroup>, …) that survive into the .md endpoint. They have no
# semantic value for indexing — strip the tags but keep their inner text.
_MDX_OPEN_TAG_RE = re.compile(r"<([A-Z][A-Za-z0-9_]*)(\s[^>]*?)?>")
_MDX_CLOSE_TAG_RE = re.compile(r"</([A-Z][A-Za-z0-9_]*)>")
_MDX_SELF_CLOSING_RE = re.compile(r"<([A-Z][A-Za-z0-9_]*)(\s[^>]*?)?/>")


def _strip_mdx(text: str) -> str:
    text = _MDX_SELF_CLOSING_RE.sub("", text)
    text = _MDX_OPEN_TAG_RE.sub("", text)
    text = _MDX_CLOSE_TAG_RE.sub("", text)
    # Collapse the blank lines left behind.
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _strip_to_text(html: str) -> str:
    """Trafilatura (markdown output) first, BeautifulSoup as a last-resort fallback.

    `output_format="markdown"` preserves headings, lists, and tables as syntax
    rather than flattening to plain text — important because GFM tables get
    destroyed if their `|`-delimited rows lose their newlines.
    """
    try:
        import trafilatura

        extracted = trafilatura.extract(
            html,
            include_comments=False,
            include_tables=True,
            favor_recall=True,
            output_format="markdown",
        )
        if extracted and extracted.strip():
            return extracted.strip()
    except Exception:
        pass
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
            tag.decompose()
        return re.sub(r"\n{3,}", "\n\n", soup.get_text("\n")).strip()
    except Exception:
        return ""


def _md_url_candidates(url: str) -> list[str]:
    """Possible Mintlify-style .md variants for a given page URL.

    Mintlify serves `<path>.md` for normal pages. The site root is the awkward
    case — we try a couple of common patterns.
    """
    parsed = urlparse(url)
    path = parsed.path or "/"
    if path == "" or path == "/":
        return [
            urlunparse(parsed._replace(path="/index.md")),
            urlunparse(parsed._replace(path="/llms.txt")),
        ]
    return [url.rstrip("/") + ".md"]


async def _extract_page(
    client: httpx.AsyncClient, url: str
) -> tuple[str, str]:
    """Return (title, text). Empty text means extraction failed."""
    # Mintlify (and a few other doc generators) expose a clean .md variant per page.
    if not url.endswith(".md") and "?" not in url:
        for md_url in _md_url_candidates(url):
            status, ct, body = await _fetch_text(client, md_url)
            if (
                status == 200
                and ("markdown" in ct.lower() or "text/plain" in ct.lower())
                and len(body) > 50
            ):
                title = _first_heading(body) or url.rsplit("/", 1)[-1] or url
                return (title, _strip_mdx(body))

    status, ct, body = await _fetch_text(client, url)
    if status != 200:
        return ("", "")
    if "html" in ct.lower():
        text = _strip_mdx(_strip_to_text(body))
        title = _html_title(body) or url.rsplit("/", 1)[-1] or url
        return (title, text)
    if "markdown" in ct.lower() or "text/plain" in ct.lower():
        title = _first_heading(body) or url.rsplit("/", 1)[-1]
        return (title, _strip_mdx(body))
    return ("", "")


_TITLE_RE = re.compile(r"<title[^>]*>([^<]+)</title>", re.IGNORECASE | re.DOTALL)
_H1_RE = re.compile(r"^#\s+(.+)$", re.MULTILINE)


def _html_title(html: str) -> str:
    m = _TITLE_RE.search(html)
    return m.group(1).strip() if m else ""


def _first_heading(md: str) -> str:
    m = _H1_RE.search(md)
    return m.group(1).strip() if m else ""


# ---------------------------------------------------------------------------
# Optional AI distillation
# ---------------------------------------------------------------------------


SMART_EXTRACT_PROMPT = """You are extracting the canonical facts from a single
documentation page so an evaluation bot can use them as ground truth.

Page title: {title}
Source URL: {url}

PAGE CONTENT (may include navigation noise):
---
{text}
---

Write a concise markdown brief with these sections (omit any that don't apply):

# {title}

## Summary
One paragraph: what this page is about and who would care.

## Key Facts
- Bullet list of explicit rules, limits, defaults, prices, supported items,
  endpoints, parameters — anything an answer would need to cite. Be precise:
  preserve numbers, names, and exact terminology.

## Examples
- Concrete examples or code/CLI snippets that appeared on the page, verbatim
  where short. Skip if none.

## Caveats
- Things that are explicitly NOT supported, deprecation notices, gotchas.

Rules:
- Use ONLY information from the page content above. Do not invent or assume.
- Prefer the page's own wording for proper nouns and product terms.
- Skip marketing copy, headers, navigation links, and footer text.
- DO NOT include MDX / JSX component tags (e.g. <Note>, <Callout>, <Card>,
  <CodeGroup>, <Frame>, <Steps>, <Tabs>, <Accordion>). If the content inside
  them is useful, fold the text into a normal paragraph or list item.
- DO NOT echo literal markdown decorations like `**Note**` or stray `>`
  blockquote markers — just write the prose plainly.
- If the page is empty or pure navigation, output: "(no extractable content)".
"""


CONSOLIDATION_PLAN_PROMPT = """You are organizing {count} documentation pages
into the minimum number of consolidated reference documents for a chatbot
evaluation knowledge base.

Each consolidated document should cover ONE cohesive topic an answer might
need to cite. Aim for 3-8 files (fewer if the content is narrow, more only
if topics genuinely diverge).

Pages (number • url • title • first-line):
{page_index}

Return ONLY a JSON object with this exact shape, no commentary, no code fence:
{{
  "files": [
    {{
      "title": "Human-readable file title",
      "slug": "kebab-case-filename",
      "description": "One sentence summary of what's covered",
      "page_indices": [1, 2, 5]
    }}
  ]
}}

Rules:
- Group pages by topic (e.g. "API Reference", "Getting Started", "MCP",
  "Analytics", "Concepts"). Use the page titles and URL paths as hints.
- Every page index 1..{count} should appear in exactly one file.
- Slugs are filenames without extension. Lowercase, hyphens, no spaces.
"""


CONSOLIDATION_WRITE_PROMPT = """You are writing a consolidated reference
document titled "{title}" for a chatbot evaluation knowledge base. A
downstream AI judge reads this VERBATIM as ground truth when scoring chatbot
answers, so be precise and grounded.

Description: {description}

SOURCE PAGES (verbatim content from {n} pages):
{sources}

Write a clean markdown document:
- Start with `# {title}` and a short intro paragraph.
- Organize into logical `##` sections; use `###` subsections for endpoint
  groups, feature areas, or sub-topics.
- Preserve exact numbers, parameter names, API paths, limits, defaults, and
  product terms.
- Where a fact comes from a specific page, cite it inline like
  `(source: <url>)`. Group multiple sources at the end of a paragraph if
  that reads cleaner.
- Use bullet lists for enumerations; tables for parameter/field references
  when the source had a table; fenced code blocks ONLY for actual code or
  request/response snippets.
- DO NOT include MDX / JSX component tags or literal `**Note**` /
  `> blockquote` markers — write plain prose.
- DO NOT include marketing copy, navigation links, or footer text.
- If multiple source pages overlap, merge their facts without restating.
- Aim for completeness on the topic, not page-by-page rehash.
- Output raw markdown directly. DO NOT wrap the entire response in a
  ```markdown … ``` fence. Code fences are only for inline code/snippets
  inside the body.
"""


# Strip the LLM tic of wrapping the entire response in ```markdown … ``` so the
# renderer doesn't see one giant code block. Only peels OUTER fences — fenced
# code blocks inside the body (for actual code snippets) are preserved.
_OUTER_FENCE_OPEN = re.compile(r"^\s*`{3,}[a-zA-Z0-9_-]*\s*\n")
_OUTER_FENCE_CLOSE = re.compile(r"\n`{3,}\s*$")


def _strip_outer_code_fence(text: str) -> str:
    s = text.strip()
    if not s.startswith("```"):
        return s
    # Only strip if there's a matching closing fence at the very end.
    open_match = _OUTER_FENCE_OPEN.match(s)
    close_match = _OUTER_FENCE_CLOSE.search(s)
    if not open_match or not close_match:
        return s
    return s[open_match.end() : close_match.start()].strip()


async def _ai_distill(title: str, url: str, text: str, provider: str | None) -> str:
    """Run a single AI call to distill a page into a structured brief.

    Returns the distilled markdown on success, or "" if the AI is unavailable
    or returns an empty/error response. Truncates very long pages to keep the
    call cheap.
    """
    from . import ai  # local import to avoid module-load cycle

    # Cap input at ~6k words to stay well under typical context windows for
    # the cheaper provider tiers; still plenty for a single docs page.
    capped = " ".join(text.split()[:6000])
    prompt = SMART_EXTRACT_PROMPT.format(title=title or "Untitled", url=url, text=capped)
    try:
        answer, _usage = await ai.chat(prompt, provider=provider)
    except Exception:
        return ""
    answer = _strip_outer_code_fence((answer or "").strip())
    if not answer or "no extractable content" in answer.lower():
        return ""
    return answer


# ---------------------------------------------------------------------------
# Consolidation: plan + write
# ---------------------------------------------------------------------------


import json as _json  # noqa: E402  (placed after constants/prompts on purpose)


def _extract_first_json_object(text: str) -> dict | None:
    """Best-effort: find the first `{...}` block and parse it.

    AI responses sometimes wrap the JSON in code fences or add a sentence of
    preamble — strip both and try again.
    """
    if not text:
        return None
    s = text.strip()
    # Strip code fences if present.
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s)
        if s.endswith("```"):
            s = s[:-3]
    # Find first { and matching last }
    start = s.find("{")
    end = s.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        return _json.loads(s[start : end + 1])
    except _json.JSONDecodeError:
        return None


async def _plan_consolidation(
    pages: list[tuple[int, str, str, str]], provider: str | None
) -> list[dict]:
    """Ask the AI to group pages into N consolidated files. Returns the file plan.

    On failure or invalid response, falls back to a single "Reference" file
    containing all pages so the rest of the pipeline still works.
    """
    from . import ai

    lines: list[str] = []
    for idx, url, title, text in pages:
        first_line = next(
            (ln.strip() for ln in text.splitlines() if ln.strip()),
            "",
        )[:120]
        lines.append(f"[{idx}] {url} • {title or '(untitled)'} • {first_line}")
    page_index = "\n".join(lines)
    prompt = CONSOLIDATION_PLAN_PROMPT.format(count=len(pages), page_index=page_index)

    try:
        answer, _usage = await ai.chat(prompt, provider=provider)
    except Exception:
        return _fallback_plan(pages)

    parsed = _extract_first_json_object(answer or "")
    if not parsed or not isinstance(parsed.get("files"), list) or not parsed["files"]:
        return _fallback_plan(pages)

    # Sanitize: ensure each file has the required keys and at least 1 valid index.
    valid: list[dict] = []
    seen_indices: set[int] = set()
    valid_idx = {p[0] for p in pages}
    for f in parsed["files"]:
        if not isinstance(f, dict):
            continue
        title = str(f.get("title") or "").strip() or "Reference"
        slug = str(f.get("slug") or "").strip() or _slugify(title)
        description = str(f.get("description") or "").strip()
        raw_indices = f.get("page_indices") or []
        indices = [int(i) for i in raw_indices if isinstance(i, (int, float)) and int(i) in valid_idx]
        if not indices:
            continue
        valid.append(
            {
                "title": title,
                "slug": _slugify(slug),
                "description": description,
                "page_indices": indices,
            }
        )
        seen_indices.update(indices)

    if not valid:
        return _fallback_plan(pages)

    # Any orphans (pages the AI dropped) get appended to a "Miscellaneous" file
    # so we don't silently lose content.
    orphans = sorted(valid_idx - seen_indices)
    if orphans:
        valid.append(
            {
                "title": "Miscellaneous",
                "slug": "miscellaneous",
                "description": "Pages that didn't fit other consolidated topics.",
                "page_indices": orphans,
            }
        )
    return valid


def _fallback_plan(pages: list[tuple[int, str, str, str]]) -> list[dict]:
    return [
        {
            "title": "Reference",
            "slug": "reference",
            "description": "All ingested documentation pages.",
            "page_indices": [p[0] for p in pages],
        }
    ]


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9._-]+", "-", name.strip()).strip("-").lower()
    return s or "reference"


async def _ai_write_consolidated(
    file_spec: dict,
    pages_by_idx: dict[int, tuple[str, str, str]],
    provider: str | None,
) -> str:
    """Generate the markdown body for one consolidated file. Returns "" on failure."""
    from . import ai

    indices = file_spec["page_indices"]
    # Pack source pages under a char budget so we stay within typical contexts.
    budget = 28_000
    used = 0
    blocks: list[str] = []
    for idx in indices:
        if idx not in pages_by_idx:
            continue
        url, title, text = pages_by_idx[idx]
        # Cap each individual page to ~3500 chars so one huge page can't crowd
        # everything else out.
        snippet = text if len(text) <= 3500 else text[:3500] + "\n…[truncated]"
        block = f"\n\n=== [{idx}] {title or url}\n{url}\n\n{snippet}"
        if used + len(block) > budget:
            blocks.append(f"\n\n=== [{idx}] {title or url}\n{url}\n\n[content omitted — context budget]")
            continue
        blocks.append(block)
        used += len(block)

    prompt = CONSOLIDATION_WRITE_PROMPT.format(
        title=file_spec["title"],
        description=file_spec.get("description") or "",
        n=len(indices),
        sources="".join(blocks),
    )
    try:
        answer, _usage = await ai.chat(prompt, provider=provider)
    except Exception:
        return ""
    return _strip_outer_code_fence((answer or "").strip())


# ---------------------------------------------------------------------------
# Indexing
# ---------------------------------------------------------------------------


def _index_page_sync(
    project_id: str, url: str, title: str, text: str
) -> int:
    chunks = _chunk_text(text)
    if not chunks:
        return 0
    collection = _get_or_create_collection(project_id)
    base = hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
    ids = [f"url_{base}_{i}" for i in range(len(chunks))]
    metadatas = [
        {
            "source": url,
            "filename": title or url,
            "url": url,
            "chunk_index": i,
            "kind": "url",
        }
        for i in range(len(chunks))
    ]
    collection.upsert(ids=ids, documents=chunks, metadatas=metadatas)
    return len(chunks)


def _index_consolidated_sync(
    project_id: str, slug: str, title: str, text: str, source_urls: list[str]
) -> int:
    chunks = _chunk_text(text)
    if not chunks:
        return 0
    collection = _get_or_create_collection(project_id)
    base = hashlib.sha1(f"consolidated:{slug}".encode()).hexdigest()[:16]
    ids = [f"con_{base}_{i}" for i in range(len(chunks))]
    sources_csv = ",".join(source_urls[:10])
    metadatas = [
        {
            "source": f"consolidated:{slug}",
            "filename": title or slug,
            "chunk_index": i,
            "kind": "consolidated",
            "source_urls": sources_csv,
        }
        for i in range(len(chunks))
    ]
    collection.upsert(ids=ids, documents=chunks, metadatas=metadatas)
    return len(chunks)


# ---------------------------------------------------------------------------
# Public: streaming ingest
# ---------------------------------------------------------------------------


async def discover_urls(seed_url: str, max_pages: int = 50) -> list[str]:
    """Return the list of same-host URLs we'd ingest, without fetching content.

    Tries sitemap variants first, falls back to a same-host BFS crawl from the
    seed. Always puts the seed in the result if it's missing.
    """
    seed = _normalize_url(seed_url)
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    async with httpx.AsyncClient(headers=headers) as client:
        urls = await _discover_sitemap_urls(client, seed, max_pages)
        if not urls:
            urls = await _bfs_crawl(client, seed, max_pages)
    if seed not in urls:
        urls = [seed, *urls]
    return urls[:max_pages]


async def ingest_url_stream(
    project_id: str,
    seed_url: str,
    max_pages: int = 20,
    urls: list[str] | None = None,
    smart_extract: bool = False,
    provider: str | None = None,
    concurrency: int = 5,
) -> AsyncIterator[IngestEvent]:
    """Yield IngestEvent objects describing progress; final event has type=done.

    Pages are processed concurrently with a configurable cap (default 5) so a
    100-page run with AI distillation finishes in a fraction of the sequential
    wall-clock without blowing past typical AI rate limits.
    """
    try:
        seed = _normalize_url(seed_url) if seed_url else ""
    except Exception as exc:
        yield IngestEvent("error", {"message": f"Invalid URL: {exc}"})
        return

    concurrency = max(1, min(concurrency, 16))

    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    async with httpx.AsyncClient(headers=headers) as client:
        if urls is None:
            yield IngestEvent("status", {"message": f"Fetching {seed}…"})
            yield IngestEvent("status", {"message": "Looking for sitemap…"})
            discovered = await _discover_sitemap_urls(client, seed, max_pages)
            if not discovered:
                yield IngestEvent(
                    "status",
                    {"message": "No sitemap found — crawling links from the seed page…"},
                )
                discovered = await _bfs_crawl(client, seed, max_pages)
            if seed and seed not in discovered:
                discovered = [seed, *discovered]
            urls = discovered[:max_pages]

        if not urls:
            yield IngestEvent("error", {"message": "No pages selected to ingest."})
            return

        urls = urls[:max_pages]
        total = len(urls)

        verb = "Fetching" if smart_extract else "Indexing"
        yield IngestEvent(
            "status",
            {
                "message": (
                    f"{verb} {total} page{'s' if total != 1 else ''} "
                    f"({concurrency} at a time)…"
                )
            },
        )

        # Bounded-concurrency worker pool. Each worker pushes events into a
        # shared queue so the generator can drain them in real time.
        queue: asyncio.Queue[IngestEvent | None] = asyncio.Queue()
        sem = asyncio.Semaphore(concurrency)
        # Chroma's PersistentClient is backed by SQLite (single writer lock).
        write_lock = asyncio.Lock()
        # Stores fetched-but-not-yet-consolidated pages when smart_extract=True.
        fetched_pages: list[tuple[int, str, str, str]] = []
        fetched_lock = asyncio.Lock()
        counts = {"indexed": 0, "chunks": 0}

        async def worker(i: int, page_url: str) -> None:
            async with sem:
                try:
                    title, text = await _extract_page(client, page_url)
                except Exception as exc:
                    await queue.put(
                        IngestEvent(
                            "page",
                            {
                                "index": i,
                                "total": total,
                                "url": page_url,
                                "status": "failed",
                                "error": f"{type(exc).__name__}: {exc}",
                            },
                        )
                    )
                    return

                if not text or len(text) < 40:
                    await queue.put(
                        IngestEvent(
                            "page",
                            {
                                "index": i,
                                "total": total,
                                "url": page_url,
                                "title": title,
                                "status": "skipped",
                                "reason": "no extractable content",
                            },
                        )
                    )
                    return

                if smart_extract:
                    # Consolidation flow: collect now, plan + write after all fetched.
                    async with fetched_lock:
                        fetched_pages.append((i, page_url, title, text))
                    await queue.put(
                        IngestEvent(
                            "page",
                            {
                                "index": i,
                                "total": total,
                                "url": page_url,
                                "title": title,
                                "status": "fetched",
                            },
                        )
                    )
                    return

                # Non-consolidation flow: index each page directly.
                try:
                    async with write_lock:
                        chunks = await asyncio.to_thread(
                            _index_page_sync, project_id, page_url, title, text
                        )
                except Exception as exc:
                    await queue.put(
                        IngestEvent(
                            "page",
                            {
                                "index": i,
                                "total": total,
                                "url": page_url,
                                "title": title,
                                "status": "failed",
                                "error": f"{type(exc).__name__}: {exc}",
                            },
                        )
                    )
                    return

                counts["indexed"] += 1
                counts["chunks"] += chunks
                await queue.put(
                    IngestEvent(
                        "page",
                        {
                            "index": i,
                            "total": total,
                            "url": page_url,
                            "title": title,
                            "status": "indexed",
                            "chunks": chunks,
                            "distilled": False,
                            "_indexed_text": text,
                        },
                    )
                )

        async def runner() -> None:
            try:
                await asyncio.gather(
                    *(worker(i, u) for i, u in enumerate(urls, start=1)),
                    return_exceptions=True,
                )
            finally:
                await queue.put(None)  # sentinel: no more events

        runner_task = asyncio.create_task(runner())
        try:
            while True:
                ev = await queue.get()
                if ev is None:
                    break
                yield ev
        except (GeneratorExit, asyncio.CancelledError):
            runner_task.cancel()
            with contextlib.suppress(BaseException):
                await runner_task
            raise

        await runner_task

        # If smart_extract is on, run the consolidation phase (plan -> write).
        if smart_extract:
            if not fetched_pages:
                yield IngestEvent(
                    "error",
                    {"message": "None of the selected pages had extractable content."},
                )
                return

            fetched_pages.sort(key=lambda p: p[0])
            yield IngestEvent(
                "status",
                {
                    "message": (
                        f"Reading {len(fetched_pages)} fetched page"
                        f"{'s' if len(fetched_pages) != 1 else ''} — AI is planning the consolidation…"
                    )
                },
            )
            plan = await _plan_consolidation(fetched_pages, provider)
            yield IngestEvent(
                "plan",
                {
                    "files": [
                        {
                            "title": f["title"],
                            "slug": f["slug"],
                            "description": f.get("description") or "",
                            "page_indices": f["page_indices"],
                        }
                        for f in plan
                    ],
                    "pages_seen": len(fetched_pages),
                },
            )

            pages_by_idx: dict[int, tuple[str, str, str]] = {
                idx: (url, title, text) for idx, url, title, text in fetched_pages
            }
            files_saved = 0
            for spec in plan:
                yield IngestEvent(
                    "file_progress",
                    {
                        "slug": spec["slug"],
                        "title": spec["title"],
                        "stage": "writing",
                    },
                )
                content = await _ai_write_consolidated(spec, pages_by_idx, provider)
                if not content or len(content) < 60:
                    yield IngestEvent(
                        "file",
                        {
                            "slug": spec["slug"],
                            "title": spec["title"],
                            "status": "skipped",
                            "reason": "AI returned empty or too-short content",
                            "page_indices": spec["page_indices"],
                        },
                    )
                    continue
                source_urls = [
                    pages_by_idx[idx][0] for idx in spec["page_indices"] if idx in pages_by_idx
                ]
                try:
                    async with write_lock:
                        chunks = await asyncio.to_thread(
                            _index_consolidated_sync,
                            project_id,
                            spec["slug"],
                            spec["title"],
                            content,
                            source_urls,
                        )
                except Exception as exc:
                    yield IngestEvent(
                        "file",
                        {
                            "slug": spec["slug"],
                            "title": spec["title"],
                            "status": "failed",
                            "error": f"{type(exc).__name__}: {exc}",
                        },
                    )
                    continue
                counts["chunks"] += chunks
                files_saved += 1
                yield IngestEvent(
                    "file",
                    {
                        "slug": spec["slug"],
                        "title": spec["title"],
                        "description": spec.get("description") or "",
                        "status": "saved",
                        "chunks": chunks,
                        "page_indices": spec["page_indices"],
                        "source_urls": source_urls,
                        # Internal — used by the API to persist preview content.
                        "_indexed_text": content,
                    },
                )

            yield IngestEvent(
                "done",
                {
                    "pages_indexed": len(fetched_pages),
                    "pages_seen": total,
                    "files_saved": files_saved,
                    "chunks": counts["chunks"],
                },
            )
            return

        # Non-consolidation flow done.
        yield IngestEvent(
            "done",
            {
                "pages_indexed": counts["indexed"],
                "pages_seen": total,
                "chunks": counts["chunks"],
            },
        )
