# EvalBot — Demo Build (6 hours, showy features)

Target: a demo meeting in ~6 hours. Optimized for **visual impact** over feature depth. Each feature creates a moment in the demo. Shortcuts noted where they save time without hurting the show.

Source docs: `improvement-deepeval.md`, `improvement-braintrust.md`.

---

## Demo Narrative (run-of-show)

1. **Open** on a clean Bot Project page — branded "AcmeSupportBot"
2. Paste a **docs URL** → live crawl indexes the knowledge base *(feature #6)*
3. Click **✨ Generate Test Questions** → 20 questions stream in, color-coded *(feature #1)*
4. Save 12 into a **Test Suite**, paste pre-loaded bot responses
5. Click **Run All** → heatmap fills left-to-right *(feature #5)*
6. Open one failing row → see **animated score tiles** with pass/fail badges *(feature #2)*
7. The PII case triggers a **red-alert banner** with the leaked email highlighted *(feature #3)*
8. On another case, type a **custom check** in plain English, re-run, watch a new metric appear *(feature #4)*
9. Close: *"This is what we'd hand the QA team Monday morning."*

---

## Feature 1 — Synthetic Question Generation (the opening "wow") *(~75 min)*

**The moment:** One click. 20 questions stream in token-by-token. Audience leans forward.

**Build:**
- "✨ Generate Test Questions" button on Bot Project page (sparkle icon matters)
- Stream LLM output via SSE — questions appear one at a time, not all at once
- Color-code by category as they land: factual (blue), edge (yellow), adversarial (red), multi-hop (purple)
- Show a rotating-text spinner: *"Reading your docs… extracting topics… probing guidelines…"*

**Backend:** Sample 8–10 diverse chunks → judge prompt with chunks + guideline files → JSON `[{question, expected_response, category, expected_to_refuse}]`. Stream via SSE.

**Shortcut:** The *"reading docs / extracting topics"* steps can be **fake 1-second delays**. The audience reads it as sophistication.

**Demo line:** *"Twenty test questions, tailored to your bot, including adversarial probes derived from your own guideline files. Zero setup."*

---

## Feature 2 — Animated Score Reveal with Pass/Fail Badges *(~60 min)*

**The moment:** Score tiles count up from 0 → final value. Failing dimensions pulse red briefly. Combined score lands with a flourish.

**Build:**
- Animate each tile with `framer-motion` count-up (~600ms)
- Green ✓ badge top-right if passed, red ✗ if failed
- Combined score tile: large, color-banded (red <60, amber 60–80, green ≥80) with a subtle glow
- Backing threshold logic: **hardcoded sensible defaults per dimension** (no settings UI for the demo)

**Hardcoded thresholds for demo:**
| Dimension | Threshold |
|---|---|
| Similarity | 0.60 |
| Accuracy | 0.70 |
| Completeness | 0.65 |
| Relevance | 0.70 |
| Readability | 0.50 |
| PII Leakage *(if hit)* | 1.0 *(any leak = fail)* |

**Shortcut:** Skip the thresholds-settings UI entirely. The audience sees the badges, not the config.

**Demo line:** *"Every dimension has its own pass/fail line. Safety strict, readability lenient. Pass rate now means something."*

---

## Feature 3 — PII Leak "Red Alert" Banner *(~45 min)*

**The moment:** A red banner slides down: **"🚨 PII Leak Detected — evaluation failed"**. The offending span is highlighted in the chatbot-response panel.

**Build:**
- ~10 lines of regex for emails, phone numbers, SSN, CC patterns
- If hit → sticky red banner above results + `bg-red-200` highlight on the span in the response panel
- A "PII" badge appears in the score grid with score 0.0

**Demo prep:** **Seed one test case with a planted email** in the bot response so this fires on cue.

```python
PII_PATTERNS = {
    "email": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}",
    "phone": r"\b\d{3}[-.]?\d{3}[-.]?\d{4}\b",
    "ssn":   r"\b\d{3}-\d{2}-\d{4}\b",
    "cc":    r"\b(?:\d[ -]*?){13,16}\b",
}
```

**Demo line:** *"Enterprise teams ask about PII first. We catch it deterministically — and we fail the eval. No LLM ambiguity."*

---

## Feature 4 — "Add a Custom Check in Plain English" Live Typing *(~75 min)*

**The moment:** You type into a textarea: *"Response must include the disclaimer 'This is not legal advice'"*. Click Add. Re-run the same eval. A new metric tile appears showing **0% — Failed** with the quoted reason.

**Build:**
- Textarea + Add button on a "Custom Checks" tab — single project, **in-memory only** (React state or `localStorage`)
- Append each check to the existing judge prompt: `Also evaluate: "{description}". Return 0-1 score and reason.`
- New tile per custom check in results, with the judge's `reason` shown inline
- "Re-run" button on the results page re-fires the same eval with the updated check list

**Shortcut:** Skip persistence. Custom checks live in client state — they survive a re-eval click, which is all the demo needs.

**Demo line:** *"Every client cares about something different. Type the rule in English. Re-run. Done. No code, no redeploy."*

---

## Feature 5 — Test Suite "Batch Run" Heatmap *(~120 min)*

**The moment:** A 12-row table fills in left-to-right with colored cells per dimension (green/amber/red). A big "9 / 12 passing" tile updates live as each row completes. One row turns red mid-run — audience sees it instantly.

**Build:**
- Reuse questions saved from feature #1
- Simple table: rows = questions, columns = dimensions, cells = colored score chips
- Sequential eval (no concurrency needed) with per-row spinner → result chip
- Top: large "X / Y passing" tile + a thin progress bar

**Shortcuts:**
- **No DB persistence for suite runs** — pure in-memory
- **Pre-paste responses** before the demo so you don't fumble typing on stage
- The Run All button just loops `/api/evaluate` — ~5–8 seconds total, which is good demo pacing
- If time slips: drop the heatmap to a simple list view with badges

**Demo line:** *"This is the workflow after every bot release. Paste responses. Run. See exactly what regressed."*

---

## Feature 6 — Ingest Docs from a URL *(~60 min)*

**The moment:** Paste `https://docs.acme.com` into the doc-upload section. A progress list streams in: *"Fetched index… found 14 pages… extracting page 3/14… chunking… embedding…"*. Index is ready in ~20 seconds.

**Build:**
- New input on the Documents tab: "Or paste a docs URL"
- Backend: `POST /api/projects/{id}/documents/url` with `{url, max_pages: 20}`
- Implementation:
  1. Fetch the URL with `httpx`
  2. If it's an HTML page → convert to markdown with `markdownify` or `trafilatura` (better content extraction)
  3. **Sitemap-aware shallow crawl:** check `/sitemap.xml`, take up to `max_pages` URLs from same domain, fetch each
  4. Each page → existing chunking + embedding pipeline → Chroma
  5. Stream progress events via SSE so the UI can show the page-by-page list

**Shortcut tier (pick based on time):**
| Effort | Scope | Looks like |
|---|---|---|
| 30 min | **Single page only** — fetch URL, markdown convert, index | "Paste a doc URL" |
| 60 min | **Sitemap-aware** — fetch /sitemap.xml, crawl up to N pages | "Paste a docs site URL" ← recommended |
| 2h+ | Full crawler with JS rendering (Playwright), retry/backoff | Don't do this for the demo |

**Dependencies to add:**
```python
# server requirements
httpx
trafilatura     # or markdownify; trafilatura handles content extraction better
```

**Demo prep:** Pre-test with a static docs site (e.g. a small public docs URL with a clean sitemap). Have a fallback file-upload path ready in case the live fetch hits a CORS/rate-limit hiccup mid-demo.

**Demo line:** *"Point us at your docs URL. We crawl, extract, chunk, and embed — your bot's knowledge base is indexed before the meeting ends."*

**Why this earns its slot:**
- Removes the boring "drag-and-drop files" moment with a live streaming visual
- Matches how prospects mentally model their docs ("they live at docs.x.com")
- Same SSE-streaming UI pattern as feature #1 — code reuse

---

## Build Order & Time Budget

| # | Feature | Time | Cumulative |
|---|---|---|---|
| 6 | URL doc ingestion *(do first — unblocks rest)* | 60 min | 1h 00m |
| 1 | Synthetic Q gen with streaming | 75 min | 2h 15m |
| 2 | Animated score tiles + badges | 60 min | 3h 15m |
| 3 | PII red-alert banner | 45 min | 4h 00m |
| 4 | Custom check live-typing | 75 min | 5h 15m |
| 5 | Batch run heatmap | 120 min | 7h 15m |

**Reality check:** 7h 15m vs 6h available. Cuts in priority order:
1. **First cut:** Reduce feature #5 from heatmap to simple list view → saves 45 min → fits in 6h 30m
2. **Second cut:** Drop feature #6 to single-page fetch (no sitemap) → saves 30 min → fits in 6h
3. **Last resort:** Drop feature #4 (custom checks) entirely — it's the most isolated → frees 75 min

**Do not cut:** #1, #2, #3. Those are the demo's emotional beats.

---

## Demo Theater Checklist

Pre-demo (do these in the last 30 minutes before the meeting):

- [ ] **Pre-load a project** named "AcmeSupportBot" with a real-ish brand
- [ ] **Pre-crawled docs** as a fallback if feature #6 hits a network hiccup
- [ ] **Planted PII case** — one test case where the bot response contains `support@acme.com` or a fake phone number
- [ ] **Planted "no disclaimer" case** for the custom-check demo
- [ ] **Pre-paste bot responses** into a clipboard snippet manager (Raycast / Alfred) so you paste 12 in seconds during feature #5
- [ ] **Rehearse the click path twice** end-to-end
- [ ] **Close the dev console** — surprise errors kill momentum
- [ ] **Backup screenshots** of features #1, #5, #6 in case the live demo glitches
- [ ] **Increase font size** in the browser (Cmd+ a few times) — the back row needs to read score tiles

---

## Architecture Notes

All features compose on the existing FastAPI + Next.js stack with **no new dependencies** beyond `httpx` and `trafilatura` (for feature #6). No new database tables required for the demo path:

- Features #1, #6: extend existing project/doc routes; stream via SSE
- Features #2, #3: pure frontend animation + a regex pass in the existing `/api/evaluate` response
- Feature #4: client-side state only
- Feature #5: client-side loop over existing `/api/evaluate`

This is intentional: persistence and proper data models are a **post-demo** problem. The demo only needs to *look* like a finished product for 15 minutes.

---

## After the Demo (if it goes well)

Promote demo features to real features per `improvement-deepeval.md` and `improvement-braintrust.md`:

| Demo feature | Production upgrade |
|---|---|
| #1 Synthetic Q gen | Persist proposed questions, edit-before-save, regenerate variants |
| #2 Score reveal | Real `ProjectThresholds` table + settings UI |
| #3 PII banner | Promote to a proper scored dimension with weighted impact (DeepEval `pii_leakage`) |
| #4 Custom checks | `CustomMetric` table + per-project persistence + weight in combined score |
| #5 Batch heatmap | Full `TestSuite` / `SuiteRun` schema + regression diff vs previous run |
| #6 URL ingest | Real crawler with JS rendering, robots.txt, scheduled re-crawl |
