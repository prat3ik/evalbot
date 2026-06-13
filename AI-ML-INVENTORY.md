# EvalBot — AI / ML / NLP Component Inventory

A single-source reference of every AI, ML, NLP, vector-store, embedding, and LLM-related component used in this project. Paths are relative to repo root (`EvalBot`).

---

## 1. LLM Judges (AI evaluation)

**Location:** `server/app/engines/judges/`

**Dispatcher:** `server/app/engines/ai.py`
- Routes judge calls to the configured provider.
- Selected via env var: `AI_JUDGE_PROVIDER` (default: `anthropic`)
- Per-call timeout: `JUDGE_TIMEOUT_SECONDS` (default: 30s)

### Providers

| Provider | File | SDK | Default model | Output |
|---|---|---|---|---|
| Anthropic | `judges/anthropic.py` | `anthropic` (AsyncAnthropic) | `claude-sonnet-4-6` | JSON, `max_tokens=2048` |
| OpenAI | `judges/openai.py` | `openai` (AsyncOpenAI) | `gpt-4o` | `response_format=json_object` |
| Google Gemini | `judges/gemini.py` | `google-generativeai` (genai) | `gemini-1.5-pro` | `response_mime_type=application/json` |
| Ollama (local) | `judges/ollama.py` | `httpx` (HTTP) | `llama3` (env: `OLLAMA_MODEL`) | `format=json` — URL `OLLAMA_BASE_URL` (default `http://localhost:11434`) |

### Judge prompt

**File:** `server/app/engines/judges/_prompt.py`
- Wraps untrusted content (question, response, reference, guidelines, conversation history) in `[TAG]...[/TAG]` blocks to neutralize prompt injection.
- All four providers share the **same** prompt template and **same** output shape.

### Scoring dimensions (each 0–100)

- `similarity` — Semantic equivalence with the reference
- `accuracy` — Factual correctness vs reference
- `completeness` — Coverage of key points from reference
- `relevance` — Answers the user's question
- `factual_consistency` — No contradictions / no fabrications
- `numeric_consistency` — Numbers, dates, prices match reference
- `refusal_appropriateness` — Whether refusal behavior is correct (else 100)

### Findings array

Each guideline violation reports: `guideline_excerpt`, `offending_span`, `reason`, `severity ∈ {minor, major, critical}`.

---

## 2. RAG Pipeline (Retrieval-Augmented Generation)

**Primary file:** `server/app/engines/rag.py`

### Vector store

- **ChromaDB** (PersistentClient, SQLite-backed)
- Storage path: `{DATA_DIR}/chroma/`
- Collections per project:
  - `project_{project_id}` — Document chunks (RAG corpus)
  - `refcache_{project_id}` — Semantic cache of past questions (see §3)

### Embedding model

- `sentence-transformers/all-MiniLM-L6-v2`
- Loaded via Chroma's `SentenceTransformerEmbeddingFunction`
- Lazy module-level singleton (also reused by the ML engine)

### Chunking strategy (`_chunk_text`)

| Param | Value |
|---|---|
| Unit | whitespace-split word tokens |
| Window | 800 tokens |
| Overlap | 100 tokens |
| Step | 700 tokens |

### Retrieval

- Default `top_k`: **5**
- Similarity: `1.0 - chroma_distance` (clamped to `[0, 1]`)
- Returned per chunk: `text`, `source` (file path or URL), `score`

### Document loaders (by extension)

| Extension | Library | Behavior |
|---|---|---|
| `.pdf` | `pypdf.PdfReader` | text per page |
| `.docx` | `python-docx` | paragraph text |
| `.md` / `.markdown` | stdlib | plain text (UTF-8, errors=ignore) |
| `.txt` | stdlib | plain text (UTF-8, errors=ignore) |

### Web ingest

**File:** `server/app/engines/web.py`

- **Crawl strategy:** sitemap-first (`/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-0.xml`, `robots.txt` `Sitemap:`); falls back to same-host BFS.
- **Libraries:**
  - `httpx` — async HTTP client
  - `trafilatura` — HTML → markdown extraction (preferred); `output_format="markdown"`, `favor_recall=True`, `include_tables=True`
  - `beautifulsoup4` — fallback HTML parsing; strips `script`/`style`/`nav`/`footer`/`header`/`aside`
- **Mintlify-aware:** tries clean `.md` endpoints before HTML extraction.
- Cleans MDX/JSX component tags (`<Note>`, `<Callout>`, `<Card>`, …) while preserving inner text.
- **Optional AI "Smart Extract" mode** — consolidates many pages into merged markdown using the judge LLM. Prompts:
  - `SMART_EXTRACT_PROMPT`
  - `CONSOLIDATION_PLAN_PROMPT`
  - `CONSOLIDATION_WRITE_PROMPT`

### Reference-answer generation (the AI-distilled "ground truth")

`server/app/engines/rag.py → generate_reference(...)`

- Prompts:
  - `REFERENCE_PROMPT_TEMPLATE` — stateless single-turn
  - `REFERENCE_PROMPT_WITH_CONTEXT_TEMPLATE` — multi-turn (with prior context)
- **Inputs:** question (+ optional `prior_context`), retrieved chunks, guideline texts.
- **Output:** concise answer grounded ONLY in documents + guidelines; if the docs don't contain enough info, the model must say the bot should say it does not know.

---

## 3. Semantic Reference Cache

**Files:**
- `server/app/services/reference.py`
- `server/app/engines/rag.py` (refcache helpers + Chroma collection)
- `server/app/config.py` (settings)

**Purpose:** Reuse a previously generated reference answer when a new question is semantically equivalent to a previously cached question. Avoids paying for both the retrieval and the LLM generation call on near-duplicates.

### Lookup order in `get_or_create_reference()`

1. **Exact-hash match** on `(project_id, sha256(question))` — fast path.
2. **Semantic lookup** (if `REFERENCE_SEMANTIC_CACHE_ENABLED`) — Chroma `refcache_{project_id}` top-1 nearest question. If `similarity >= REFERENCE_SEMANTIC_CACHE_THRESHOLD`, reuse the linked `ReferenceAnswer` row from SQLite.
   - **Stale-pointer recovery:** if the row was deleted, the dead Chroma entry is evicted and the flow falls through to step 3.
3. **Generate fresh** via `rag.generate_reference`, persist to SQLite, and upsert the question text into the refcache collection.

### Settings (`server/app/config.py`)

| Setting | Default |
|---|---|
| `REFERENCE_SEMANTIC_CACHE_ENABLED` | `True` |
| `REFERENCE_SEMANTIC_CACHE_THRESHOLD` | `0.85` |

> Tuned for `sentence-transformers/all-MiniLM-L6-v2`, which saturates around 0.85–0.90 for near-paraphrases. Set higher for stricter reuse.

**Scope:** Single-chat and dataset evaluations only. Multi-turn references depend on conversation history and are intentionally **not** cached this way.

### Public helpers (`server/app/engines/rag.py`)

- `index_reference_question(project_id, reference_id, question)`
- `find_similar_reference(project_id, question, threshold) -> (id, sim) | None`
- `delete_reference_from_cache(project_id, reference_id)`
- `delete_project_collection(project_id)` — drops **both** `project_` and `refcache_` collections

---

## 4. ML / NLP Evaluation Engine

**Primary files:** `server/app/engines/ml.py`, `server/app/scoring.py`

### Libraries and sub-metrics

| Library | Function | Computes |
|---|---|---|
| `sentence-transformers` (`all-MiniLM-L6-v2`) | `_semantic_score` | Cosine similarity (response vs reference); also used for `relevance` (response vs question) |
| `rapidfuzz` | `_lexical_score` | `avg(token_set_ratio, partial_ratio)` |
| `textstat` | `_readability_score` | Flesch Reading Ease → mapped to 0–100, ideal band ~60–80 |
| regex (stdlib) | `_numeric_score` | Jaccard recall over numeric tokens in reference |
| regex (stdlib) | `_entity_score` | Capitalized-entity Jaccard overlap |
| regex (stdlib) | `_length_ratio_score` | word-count ratio (penalty if `<0.5` or `>2.0`) |
| regex (stdlib) | `_refusal_score` | binary refusal-phrase detection (0 or 100) |

### Composed scoring dimensions (`ml.py → _score_sync`)

```
similarity    = 0.7 * semantic + 0.3 * lexical
accuracy      = 0.5 * semantic + 0.3 * numeric + 0.2 * entity
completeness  = 0.6 * length   + 0.4 * lexical
relevance     = semantic(response, question)
readability   = Flesch-mapped(response)
```

### Final combined score (`scoring.py → combine()`)

```
combined = 0.35 * similarity
         + 0.25 * accuracy
         + 0.25 * completeness
         + 0.10 * relevance
         + 0.05 * readability
```

### Refusal-aware variants

- `combine_judge_refusal_mode()`
- `combine_ml_refusal_mode()`

Used when the chatbot legitimately refuses; re-weights so refusal appropriateness dominates.

---

## 5. PII Detection

**File:** `server/app/engines/pii.py`
**Approach:** Deterministic regex + Luhn validation (**no ML model**)

### Patterns

| Kind | Pattern |
|---|---|
| email | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` |
| phone | `\b\d{3}[-.]?\d{3}[-.]?\d{4}\b` |
| ssn | `\b\d{3}-\d{2}-\d{4}\b` |
| credit_card | `\b(?:\d[ -]*?){13,16}\b` + Luhn checksum |

**API:** `scan_pii(text) -> list[PIIHit]` — each hit: `kind`, `span`, `position`. Designed to be over-eager: false positives acceptable, false negatives are not.

---

## 6. Synthetic Question Generation

**File:** `server/app/api/question_gen.py`
**Approach:** LLM-driven generation, streamed back as SSE/NDJSON.

### Provider selection

Same dispatcher as the judge (`AI_JUDGE_PROVIDER`), with some provider-specific model overrides for cost:

| Provider | Model | Notes |
|---|---|---|
| OpenAI | `gpt-4o-mini` | streaming `chat.completions` |
| Anthropic | `claude-sonnet-4-6` | `messages.stream` |
| Others | (config default) | non-streaming call, re-emitted char-by-char for UI |

### Prompt inputs

- Top-k document chunks from RAG (project corpus)
- Project guideline texts
- Requested categories: `factual`, `edge`, `adversarial`, `multi_hop`
- Requested count N

### Expected output (one JSON object per line)

```json
{"question": "...", "expected_response": "...", "category": "...", "expected_to_refuse": false}
```

### Streaming events emitted

`stage | question | warn | error | done`

---

## 7. Custom Checks

**File:** `server/app/api/custom_checks.py`
**Status:** **DISABLED** (feature-flagged off; router is a no-op).

Designed shape (commented):
- Per-project plain-English check definitions, each with a weight `0..1`.
- Judge would score every check (0–100 + pass/fail).

---

## 8. AI/ML-Related Python Dependencies

From `server/pyproject.toml`:

| Package | Purpose |
|---|---|
| `anthropic` | Anthropic SDK (judge) |
| `openai` | OpenAI SDK (judge, question generation) |
| `google-generativeai` | Gemini SDK (judge) |
| `sentence-transformers` | `all-MiniLM-L6-v2` embeddings (RAG, ML scoring, semantic ref cache) |
| `chromadb` | Vector store (RAG + refcache) |
| `rapidfuzz` | Fuzzy/lexical similarity (ML scoring) |
| `textstat` | Flesch readability (ML scoring) |
| `pypdf` | PDF text extraction |
| `python-docx` | DOCX text extraction |
| `markdown-it-py` | Markdown parsing |
| `trafilatura` | HTML → markdown extraction (web ingest) |
| `beautifulsoup4` | HTML parsing fallback (web ingest) |
| `httpx` | Async HTTP (web ingest, Ollama judge) |

**Implicit:** `numpy` — cosine / vector ops (transitive via `sentence-transformers`).

---

## 9. One-Line Summary Map

| Component | Path |
|---|---|
| LLM judges (4 providers) | `server/app/engines/judges/*.py` + `ai.py` |
| Judge prompt + dimensions | `server/app/engines/judges/_prompt.py` |
| RAG corpus + retrieval | `server/app/engines/rag.py` |
| Web ingest + smart extract | `server/app/engines/web.py` |
| Reference cache (hash) | `server/app/services/reference.py` |
| Reference cache (semantic) | `server/app/services/reference.py` + `rag.py` |
| ML/NLP scoring | `server/app/engines/ml.py` |
| Score combination weights | `server/app/scoring.py` |
| PII detection (regex + Luhn) | `server/app/engines/pii.py` |
| Synthetic question gen | `server/app/api/question_gen.py` |
| Vector store on disk | `{DATA_DIR}/chroma/` |
| SQLite app DB | `{DATA_DIR}/evalbot.db` |
