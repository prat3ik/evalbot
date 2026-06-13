# EvalBot

An Alphabin internal product for chatbot testing — a lightweight, explainable alternative to DeepEval.

EvalBot evaluates chatbot responses against a **ground truth derived from the bot's own knowledge base** — uploaded documents (RAG corpus) and a **rule schema** describing the bot's policies and expected behavior. The user **manually pastes** the chatbot's answer; EvalBot scores it against what the RAG + rules say the correct answer should be, using a hybrid of classical ML/NLP metrics and an LLM-as-judge. It returns a weighted final score plus a short rationale so product teams know **what to fix and why**.

> MVP scope: simple UI + simple backend + minimal DB. Runs locally on a developer machine — no auth, no Docker, no batch jobs.

---

## Core Idea

Per chatbot under test, you register a **Bot Project** consisting of:

- **Documents** — the same corpus the chatbot is grounded on (PDF, MD, TXT, DOCX). Chunked + embedded into a local vector store.
- **Rule / guideline files** — free-form Markdown files describing the company's guidelines for that bot (e.g. *"never reveal another user's data"*, *"always refuse questions about competitor pricing"*, allowed tone, required disclaimers, refusal patterns). No fixed schema — drop in any number of `*.md` files (also accepts skill-style files). The AI judge reads them verbatim as part of its prompt.

When a user pastes a `(question, chatbot response)` pair:

1. EvalBot retrieves the top-k relevant chunks from the bot's documents.
2. A **reference answer** is generated on the fly by an LLM grounded on those chunks + the guideline files. (Cached per question.)
3. Two evaluators then score the triple `(question, chatbot response, reference answer)`:

- **ML/NLP engine** — deterministic, fast, no API calls. Lexical + semantic similarity, completeness, accuracy proxies, relevance, readability.
- **AI judge** — an LLM that produces per-dimension scores and a short natural-language rationale highlighting missing concepts, format mismatches, and **guideline violations** found by reading the guideline files alongside the response.

The two are combined into a **Combined Score**. Disagreement between the two engines is itself a signal (surfaced in analytics).

### Default Scoring Weights

| Dimension     | Weight |
|---------------|--------|
| Similarity    | 35%    |
| Accuracy      | 25%    |
| Completeness  | 25%    |
| Relevance     | 10%    |
| Readability   | 5%     |

Weights are configurable per evaluation run.

---

## Features (MVP)

### 1. Bot Projects
- Create a project for each chatbot under test
- **Upload documents** — drag-and-drop PDFs / MD / TXT / DOCX; chunked and embedded into a local vector store (Chroma or LanceDB)
- **Upload guideline files** — any number of `.md` files (free-form, skill-style, or plain rule lists). Example shapes that all work:

  ```markdown
  # Support Bot Guidelines

  - Never reveal personal data of other users.
  - Refuse any request to bypass authentication or access controls.
  - Maintain a professional, polite tone.
  - When asked for legal/medical advice, append: "This is not legal advice."
  - Use the refusal template: "I can't help with that because…"
  ```

  Or a skill-style file with sections (`## Tone`, `## Refusal patterns`, `## Disclaimers`). EvalBot does not parse the structure — the AI judge consumes the raw text.

- Each evaluation is tied to a project so retrieval and guidelines are scoped correctly

### 2. Evaluate page
- Inputs:
  - **Bot Project** — pick which bot is being tested
  - **Test Question** — pick from the **seed question library** (categories: Security, Harmfulness, Fact-Check, Hallucination, plus project-specific) or type a custom one
  - **Chatbot Response** — **pasted manually** by the user
  - **Reference Answer** — auto-generated from RAG + guideline files (read-only preview, with an "edit" affordance if the user wants to override)
  - **Evaluation Method** — ML/NLP only, AI only, or Both
  - **AI Provider / Model** — dropdown: Claude, Gemini, OpenAI/Codex, Ollama (+ specific model)
- Outputs:
  - **ML/NLP Score**, **AI Score**, **Combined Score** (large tiles)
  - **Detailed Metrics**: Similarity, Completeness, Accuracy, Relevance (with bars)
  - **ML Details**: per-sub-metric breakdown with weights (Semantic, Lexical, Readability, Toxicity, Sentiment, Factual Consistency, Numeric Consistency, Length, etc.)
  - **AI Details**: per-dimension model-evaluated scores (Similarity, Completeness, Accuracy, Relevance, Factual Consistency, Numeric Consistency, Refusal Appropriateness)
  - **Guideline Compliance**: list of guidelines the AI judge flagged as violated, each with the offending span quoted from the chatbot response and a one-line reason
  - **Retrieved Context**: the doc chunks used to build the reference answer (so users can see what was considered ground truth)
  - **Rationale**: short natural-language explanation from the AI judge

### 3. Analytics dashboard
- **Filters**: date range, category, evaluation method
- **Summary tiles**: Total Evaluations, Average Score, Pass Rate, This Week, Safety Questions, Entity Agreement
- **Key Insights** cards: e.g. "Safety Compliance Concerns", "High Evaluator Disagreement", "Overall Performance"
- **Tabs**: Overview, Agreement, Performance, Quality, Content, Dataset
- **ML vs AI Score Agreement** chart (scatter or correlation)
- **Performance by Category / Dimension** matrix
- **Export to CSV**

### 4. Evaluation history (Dashboard)
- List of recent evaluations with question, scores, timestamp, project
- Click into a row to see the full breakdown again

### 5. Seed Question Library
Ships with EvalBot, browseable on the Evaluate page. Categories:
- **Security** — prompt-injection, data exfiltration attempts, auth bypass
- **Harmfulness** — toxic / unsafe content probes
- **Fact-Check** — questions with verifiable answers (used with the project's docs)
- **Hallucination** — out-of-scope / unanswerable questions where the correct behavior is to refuse or say "I don't know"

Stored as a JSON file in `server/seed/questions.json`. Users can also save custom questions back into the library per project.

---

## UI / UX

Style follows the screenshots: clean, light theme, card-based layout, rounded corners, subtle borders, monospace/sans mix for numbers.

**Layout**
- Left sidebar: `Dashboard`, `Bot Projects`, `Evaluate`, `Analytics`
- Top of each page: page title + one-line subtitle
- Main content: two-column on Evaluate (form left, results right), single-column dashboards on Analytics

**Key components**
- Score tile (big number, label, subtle color band by score range: red <60, amber 60–80, green ≥80)
- Metric bar (label + % + horizontal bar)
- Stat card (number + label + delta)
- Insight card (icon + title + 1-line takeaway + count)
- Tabs, filter chips, CSV export button

---

## Tech Stack

Picked for **fast MVP, offline-friendly, single-machine deploy**.

### Frontend
- **Next.js 14 (App Router) + React + TypeScript**
- **Tailwind CSS** + **shadcn/ui** for components (matches the screenshot aesthetic out of the box)
- **Recharts** for charts (scatter, bar, matrix)
- **TanStack Query** for server state

### Backend
- **FastAPI** (Python) — single service, async, easy to extend
- Endpoints:
  - `POST /api/projects` — create a bot project
  - `POST /api/projects/{id}/documents` — upload + index documents
  - `POST /api/projects/{id}/guidelines` — upload guideline `.md` files
  - `POST /api/projects/{id}/reference` — generate/retrieve the reference answer for a question
  - `POST /api/evaluate` — run a single evaluation (project_id, question, chatbot_response)
  - `GET  /api/evaluations` — list with filters
  - `GET  /api/evaluations/{id}` — detail (incl. retrieved chunks + guideline findings)
  - `GET  /api/questions` — seed question library
  - `GET  /api/analytics/summary` — dashboard tiles
  - `GET  /api/analytics/agreement` — ML vs AI scatter data

### RAG / ground-truth engine
- **Chroma** (or LanceDB) as the local vector store — single-file, embedded, no separate server
- **sentence-transformers** for embeddings (same model as the similarity metric)
- Document loaders: `pypdf`, `python-docx`, `markdown-it-py`, plain text
- Chunking: ~800 token windows, ~100 token overlap
- Reference answers generated by the selected AI provider, grounded on top-k chunks + the full text of the guideline `.md` files, cached per `(project_id, question)`
- Guideline checker: AI judge reads the raw guideline files and returns a list of `{guideline_excerpt, offending_span, reason}` findings — no schema parsing required

### ML/NLP engine
- `sentence-transformers` (`all-MiniLM-L6-v2`) for semantic similarity — runs locally, no API
- `rapidfuzz` for lexical similarity (token-set ratio, partial ratio)
- `textstat` for readability (Flesch-Kincaid)
- Simple numeric/entity extraction with regex + spaCy (small model) for factual/numeric consistency
- Optional: `detoxify` (small) for toxicity if needed

### AI judge (multi-provider)
A pluggable provider layer so any supported model can act as the judge. Selectable per-evaluation from the UI and configurable via env.

Supported providers (MVP):
- **Anthropic Claude** (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`)
- **Google Gemini** (`gemini-1.5-pro`, `gemini-1.5-flash`)
- **OpenAI** (`gpt-4o`, `gpt-4o-mini`, plus Codex-style code models)
- **Ollama** (local — `llama3`, `mistral`, `qwen`, etc., for offline use)
- **Azure OpenAI** (stretch — same OpenAI client, different base URL)

Design:
- A single `JudgeProvider` interface in `server/app/engines/judges/` with one file per provider (`anthropic.py`, `gemini.py`, `openai.py`, `ollama.py`)
- Shared structured-output prompt returning per-dimension scores + rationale (JSON), with provider-specific JSON-mode / tool-use plumbing
- API keys read from env: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_BASE_URL`
- Default provider via `AI_JUDGE_PROVIDER` env, overridable per-request
- **Multi-judge mode**: optionally run 2+ providers on the same input and surface inter-judge agreement as another signal in Analytics

### Database
- **SQLite** via SQLModel/SQLAlchemy — one file, zero ops
- Tables: `project`, `document`, `guideline_file`, `reference_answer` (cache), `evaluation`, `metric_score`, `guideline_finding`, `question` (seed + custom)

### Deployment / Running locally
- No Docker. MVP runs as two local processes on one machine:
  - `cd server && uv run uvicorn app.main:app --reload --port 8000`
  - `cd client && pnpm dev` (port 3000)
- All data lives under `./data/` (SQLite file, Chroma index, uploaded docs + guideline files, model cache)
- API keys read from a local `.env` (gitignored)

---

## Repository Layout (planned)

```
EvalBot/
├── client/                # Next.js app
│   ├── app/
│   │   ├── (dashboard)/
│   │   ├── evaluate/
│   │   └── analytics/
│   ├── components/
│   └── lib/
├── server/                # FastAPI app
│   ├── app/
│   │   ├── api/           # routes
│   │   ├── engines/
│   │   │   ├── ml.py      # ML/NLP scorer
│   │   │   ├── ai.py      # AI judge dispatcher
│   │   │   ├── judges/    # one file per provider (claude, gemini, openai, ollama)
│   │   │   ├── rag.py     # retrieval + reference-answer generation
│   │   │   └── rules.py   # rule-schema validator
│   │   ├── models.py      # SQLModel tables
│   │   ├── scoring.py     # weighted combination
│   │   └── main.py
│   ├── seed/questions.json   # seed question library
│   ├── data/              # SQLite + Chroma index + uploaded docs + guideline files + model cache (gitignored)
│   │   ├── evalbot.db
│   │   ├── chroma/
│   │   ├── projects/<project_id>/docs/        # uploaded reference documents
│   │   └── projects/<project_id>/guidelines/  # uploaded guideline .md files
│   └── pyproject.toml
├── docs/                  # design notes, specs
│   ├── design.md
│   └── EvalBot.txt
└── README.md
```

---

## Scoring Formula

```
combined = 0.35*similarity + 0.25*accuracy + 0.25*completeness + 0.10*relevance + 0.05*readability
ml_score      = combined computed from ML/NLP sub-metrics
ai_score      = combined computed from AI-judge sub-metrics
final_score   = (ml_score + ai_score) / 2     # if both engines run
```

Pass threshold default: `final_score >= 75`.

---

## Running locally

Two processes, two terminals. No Docker, no auth.

### Prerequisites

- **Python 3.11+** and [**uv**](https://docs.astral.sh/uv/) (Python package/runtime manager)
- **Node 20+** and **pnpm 9+** (`npm i -g pnpm`)
- **(Optional) [Ollama](https://ollama.com)** — only if you want a fully offline AI judge instead of a cloud provider

### Server setup (terminal 1)

```bash
cd server
cp .env.example .env           # then fill in keys for whichever provider you want to use
uv sync                        # installs Python deps into ./server/.venv
uv run uvicorn app.main:app --reload --port 8000
```

API at <http://localhost:8000>, OpenAPI docs at <http://localhost:8000/docs>.

### Client setup (terminal 2)

```bash
cd client
pnpm install
pnpm dev                       # starts Next.js on port 3000
```

Open <http://localhost:3000>. You should land on the Dashboard.

### First-run notes

- The first evaluation request downloads the **MiniLM** sentence-transformers embedding model (~80 MB) into the local HuggingFace cache. Subsequent runs are instant.
- All persistent state — SQLite DB, Chroma index, uploaded docs, guideline files — lives under `server/data/` (gitignored).
- If you hit `missing provider credentials` when running an evaluation, the relevant `*_API_KEY` isn't loaded — restart the server after editing `server/.env`.

### Verify

```bash
curl http://localhost:8000/api/health     # -> {"status":"ok"}
curl http://localhost:8000/api/questions  # -> seed question library
```

---

## Running with Ollama (fully offline)

Ollama lets you run the AI judge on your own machine — no API keys, no network calls.

**1. Install Ollama**

```bash
brew install ollama            # macOS
# or download from https://ollama.com for Linux / Windows
ollama serve                   # start the daemon (auto-starts on macOS after install)
```

**2. Pull a model**

```bash
ollama pull llama3.1           # default; ~4.7 GB
# alternatives worth trying:
ollama pull qwen2.5:7b
ollama pull mistral
```

**3. Configure `server/.env`**

```bash
AI_JUDGE_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1
```

**4. Restart the server**, then verify Ollama is reachable and run any evaluation that uses the AI judge:

```bash
curl http://localhost:11434/api/tags    # lists installed models => Ollama is up
```

**Tradeoffs.** Ollama is fully local and free, but quality is noticeably lower than cloud frontier models (Claude / GPT-4o / Gemini). For code-heavy or long-context evaluation, consider `ollama pull qwen2.5-coder` or `llama3.1:70b` (needs ~40 GB RAM).

---

## Out of Scope for MVP

- Auth (no users, single-machine local tool)
- Docker / cloud deployment
- Batch / CSV evaluation — single eval only
- LLM evaluation per se — this is **chatbot eval against company docs + guidelines**, not a general LLM benchmark
- Live chatbot integration (responses are pasted in)
- Agentic / multi-step RAG — MVP uses single-shot retrieval + generation
- Heavy infra: queues, workers, distributed tracing

---

## Decisions Locked In

- ✅ Chatbot eval **against the company's own docs + guidelines** — not generic LLM eval. No "Quality vs Policy/Safety" mode toggle; there's one mode.
- ✅ **Local-only**, run as two processes (`uvicorn` + `next dev`). No Docker, no cloud.
- ✅ **No auth** for MVP.
- ✅ **Single-evaluation** flow only; no batch / CSV ingest.
- ✅ Guidelines uploaded as **free-form `.md` files** (skill-style allowed). No fixed schema.
- ✅ **Reference documents** uploaded per project (PDF / MD / TXT / DOCX) and indexed locally.
- ✅ **Seed question library** ships with the app, organized by Security / Harmfulness / Fact-Check / Hallucination.

## Open Questions

1. **Default AI judge provider** — Claude, Gemini, OpenAI, or Ollama? All four are supported; just need a default. Also: ship **multi-judge mode** (run 2+ providers, compare) in MVP or v2?
2. **Guideline violation impact on score** — should AI-judge findings reduce the score via the existing weights, or should they sit as a separate "Findings" panel alongside the numeric score? (No schema, so no severity field — but the judge could be asked to tag each finding `minor / major / critical`.)
3. **"Entity agreement" tile** (visible in the Analytics screenshot) — what should this measure? Best guess: overlap of named entities (people, products, numbers) between chatbot response and reference. Confirm or replace.

## License

EvalBot is licensed under the **Apache License 2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

You're free to use, modify, and distribute it, including commercially. In return, the license asks that you keep the copyright and `NOTICE` attribution intact so the origin of the work stays clear. The "EvalBot" name and marks are not licensed for your own products (Apache-2.0 §6).

If you adopt or build on EvalBot, we'd love to feature your logo and a short case study — see `NOTICE` for how to reach out. This is an open invitation, not a condition of the license.
