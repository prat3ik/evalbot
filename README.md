<div align="center">

# 🤖 EvalBot

### Explainable evaluation for the chatbots you ship.

Score any assistant's answers against **your own knowledge base and policies** — combining
deterministic ML/NLP metrics with a multi-provider LLM judge, so you know exactly **what to fix and why**.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Next.js 14](https://img.shields.io/badge/Next.js-14-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Local-first](https://img.shields.io/badge/Local--first-no%20cloud%20required-success)](#-quickstart)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#-contributing)

[Features](#-features) • [How it works](#-how-it-works) • [Quickstart](#-quickstart) • [Docs](docs/) • [Architecture](#-architecture) • [Providers](#-ai-judge-providers) • [License](#-license)

</div>

<p align="center">
  <img src="assets/evaluate.png" alt="EvalBot — evaluate a chatbot response against ground truth with hybrid ML + AI scoring" width="100%">
</p>

---

## Overview

Most chatbot QA is vibes-based: someone reads a few answers and decides whether they "feel right."
**EvalBot replaces that with a repeatable, explainable score.**

For each chatbot under test you create a **Bot Project** and give it two things:

- **Documents** — the same corpus your bot is grounded on (PDF / MD / TXT / DOCX), chunked and embedded into a local vector store.
- **Guideline files** — free-form Markdown describing your policies (*"never reveal another user's data,"* *"always refuse competitor-pricing questions,"* tone, required disclaimers, refusal patterns). No schema — the AI judge reads them verbatim.

Then you paste a `(question, chatbot answer)` pair. EvalBot generates the *correct* answer from your docs + guidelines, scores the bot's answer against it from two independent angles, and tells you precisely where it fell short — including any **guideline violations**, with the offending sentence quoted.

It runs entirely on your machine. No Docker, no account, no data leaving your laptop — and a fully offline mode via Ollama.

---

## 📖 Documentation

Short and to the point — read in a couple of minutes:

- **[How it works](docs/how-it-works.md)** — the scoring pipeline + user workflow, with flowcharts.
- **[Usage guide](docs/usage.md)** — evaluate a bot, step by step.
- **[Glossary](docs/glossary.md)** — every term in plain English.
- **[How EvalBot compares](docs/comparison.md)** — vs promptfoo, deepeval, garak & friends.

---

## ✨ Features

| | |
|---|---|
| 🎯 **Hybrid scoring** | A deterministic **ML/NLP engine** (semantic + lexical similarity, completeness, accuracy, relevance, readability, toxicity, numeric/factual consistency) runs alongside an **LLM-as-judge**. Engine disagreement is itself a tracked signal. |
| 📚 **Grounded ground truth** | Reference answers are generated on the fly from the top-_k_ retrieved chunks of *your* documents — not from the model's general knowledge — and cached per question. |
| 🛡️ **Guideline compliance** | The judge reads your raw policy files and returns each violation with the **offending span quoted** and a one-line reason. |
| 🔌 **Multi-provider judges** | Claude, Gemini, OpenAI, and **Ollama** (offline). Switch per evaluation, or run several and compare inter-judge agreement. |
| 🗂️ **Datasets & runs** | Bundle questions into datasets, run them as a batch, and track results across runs with a pass/fail heatmap. |
| 💬 **Multi-turn conversations** | Evaluate full multi-step exchanges, not just single Q&A pairs. |
| ✅ **Custom checks** | Define your own pass/fail assertions on top of the built-in metrics. |
| 🔐 **PII detection** | A built-in engine flags personal data leakage in responses. |
| 📈 **Analytics** | Pass rate, score trends, ML-vs-AI agreement, performance by category & dimension, and CSV export. |
| 🧪 **Seed question library** | Ships with Security, Harmfulness, Fact-Check, and Hallucination probes. Save your own per project. |
| 💻 **Local-first** | FastAPI + Next.js, SQLite + embedded Chroma. Zero infra to stand up. |

<p align="center">
  <img src="assets/analytics.png" alt="EvalBot analytics dashboard — pass rate, evaluator agreement, and performance by category" width="100%">
</p>

---

## 🧠 How it works

When you submit a `(question, chatbot response)` pair for a project:

1. **Retrieve** — EvalBot pulls the top-_k_ relevant chunks from that project's documents.
2. **Reference** — an LLM, grounded on those chunks **+ the full text of your guideline files**, drafts the correct answer (cached per question).
3. **Score** — two evaluators independently grade the triple `(question, response, reference)`:
   - **ML/NLP engine** — fast, deterministic, no API calls.
   - **AI judge** — per-dimension scores, a plain-language rationale, and guideline-violation findings.
4. **Combine** — the two are merged into a **Combined Score**, and the result is stored for history and analytics.

### Scoring

```
combined    = 0.35·similarity + 0.25·accuracy + 0.25·completeness + 0.10·relevance + 0.05·readability
final_score = (ml_score + ai_score) / 2          # when both engines run
```

| Dimension | Weight |
|-----------|:------:|
| Similarity | 35% |
| Accuracy | 25% |
| Completeness | 25% |
| Relevance | 10% |
| Readability | 5% |

Weights are configurable per run. Default pass threshold: **`final_score ≥ 75`**.

---

## 🚀 Quickstart

EvalBot runs as two local processes — a FastAPI backend and a Next.js frontend.

### Prerequisites

- **Python 3.11+** and [**uv**](https://docs.astral.sh/uv/)
- **Node 20+** and **pnpm 9+** (`npm i -g pnpm`)
- *(Optional)* [**Ollama**](https://ollama.com) — for a fully offline AI judge

### 1 — Backend

```bash
cd server
cp .env.example .env          # add a key for whichever provider you'll use
uv sync                       # install deps into ./server/.venv
uv run uvicorn app.main:app --reload --port 8000
```

API → <http://localhost:8000> · interactive docs → <http://localhost:8000/docs>

### 2 — Frontend

```bash
cd client
pnpm install
pnpm dev                      # http://localhost:3000
```

### 3 — Verify

```bash
curl http://localhost:8000/api/health     # -> {"status":"ok"}
curl http://localhost:8000/api/questions   # -> seed question library
```

> **First run** downloads the MiniLM embedding model (~80 MB) into the local HuggingFace cache; subsequent runs are instant. All state (SQLite DB, Chroma index, uploaded docs & guidelines) lives under `server/data/`, which is gitignored.

### Seed a demo project (optional)

```bash
cd server
uv run python -m app.seed_demo            # creates a sample project + datasets
uv run python -m app.seed_demo_activity   # adds historical runs for the analytics views
```

---

## 🔌 AI judge providers

A pluggable provider layer (`server/app/engines/judges/`) lets any supported model act as the judge — selectable per evaluation in the UI and configurable via env.

| Provider | Env | Example models |
|----------|-----|----------------|
| **Anthropic Claude** | `ANTHROPIC_API_KEY` | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` |
| **Google Gemini** | `GEMINI_API_KEY` | `gemini-1.5-pro`, `gemini-1.5-flash` |
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o`, `gpt-4o-mini` |
| **Ollama** (offline) | `OLLAMA_BASE_URL` | `llama3.1`, `qwen2.5`, `mistral` |

Set a default with `AI_JUDGE_PROVIDER`; override per request from the Evaluate page.

<details>
<summary><strong>Run fully offline with Ollama</strong></summary>

```bash
brew install ollama            # macOS (or download from ollama.com)
ollama serve
ollama pull llama3.1           # ~4.7 GB
```

Then in `server/.env`:

```bash
AI_JUDGE_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1
```

Restart the server and confirm Ollama is reachable:

```bash
curl http://localhost:11434/api/tags
```

Ollama is free and private, but quality trails frontier cloud models. For code-heavy or long-context evaluation try `qwen2.5-coder` or `llama3.1:70b` (~40 GB RAM).

</details>

---

## 🏗️ Architecture

**Frontend** — Next.js 14 (App Router) · React 18 · TypeScript · Tailwind CSS · Recharts · Framer Motion · TanStack Query
**Backend** — FastAPI · SQLModel/SQLite · Chroma (embedded vector store) · sentence-transformers
**ML/NLP** — `sentence-transformers` (MiniLM) · `rapidfuzz` · `textstat` · regex/entity consistency
**AI judges** — Anthropic · Google · OpenAI · Ollama, behind one `JudgeProvider` interface

```
evalbot/
├── client/                      # Next.js app
│   ├── app/
│   │   ├── projects/[id]/        # overview · evaluate · datasets · checks · analytics · activity · runs
│   │   └── evaluations/[id]/     # full result breakdown
│   ├── components/               # score tiles, metric bars, heatmap, charts, dialogs
│   └── lib/                       # api client, formatting, thresholds
├── server/                       # FastAPI app
│   ├── app/
│   │   ├── api/                   # projects, documents, guidelines, evaluate, datasets,
│   │   │                          # conversations, custom_checks, analytics, questions, …
│   │   ├── engines/
│   │   │   ├── rag.py             # retrieval + grounded reference generation
│   │   │   ├── ai.py              # AI-judge dispatcher
│   │   │   ├── judges/            # anthropic · gemini · openai · ollama
│   │   │   ├── rules.py           # ML/NLP scoring
│   │   │   ├── pii.py             # PII detection
│   │   │   └── web.py             # web-context fetcher
│   │   ├── models.py              # SQLModel tables
│   │   ├── scoring.py             # weighted combination
│   │   ├── seed_*.py              # demo data + seed question library
│   │   └── main.py
│   └── pyproject.toml
└── assets/                       # screenshots
```

---

## 🗺️ Roadmap

- Live chatbot connectors (evaluate against an endpoint instead of pasted answers)
- Severity-tagged guideline findings feeding the numeric score
- Scheduled / CI-triggered dataset runs with regression alerts
- Authentication & multi-user workspaces

Have an idea? [Open an issue](https://github.com/prat3ik/evalbot/issues).

---

## 🤝 Contributing

Issues and PRs are welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** and the [`good first issue`](https://github.com/prat3ik/evalbot/labels/good%20first%20issue) list. For larger changes, open an issue first to discuss direction. Keep PRs scoped and note what you verified.

---

## 📄 License

EvalBot is licensed under the **Apache License 2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

You're free to use, modify, and distribute it, including commercially. The license asks only that you keep the copyright and `NOTICE` attribution intact so the origin of the work stays clear; the "EvalBot" name and marks are not licensed for your own products (Apache-2.0 §6).

> 💡 If you adopt or build on EvalBot, we'd love to feature your logo and a short case study — see [`NOTICE`](NOTICE) for how to reach out. It's an open invitation, never a condition of the license.
