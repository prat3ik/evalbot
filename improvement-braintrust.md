# EvalBot ← Braintrust — Improvement Plan

A comparison between EvalBot (Alphabin internal, MVP) and **Braintrust** (braintrust.dev), with a focus on the two patterns the slides highlight: **Prompt + Tools** and **Agents** (chained prompts).

Sources:
- Braintrust docs: https://www.braintrust.dev/docs
- Braintrust evals guide: https://www.braintrust.dev/docs/guides/evals
- Slides provided: *Task Patterns: Prompt + Tools*, *Task Patterns: Agents*
- EvalBot: `./README.md`, `./EvalBot.txt`
- Companion: `./improvement-deepeval.md`

---

## 1. Positioning Diff

| | **EvalBot** | **Braintrust** |
|---|---|---|
| Audience | Product/QA teams testing a deployed chatbot grounded in company docs + guidelines | AI engineering teams building & iterating on LLM apps end-to-end |
| Form factor | Local web app (Next.js + FastAPI), no auth, no cloud | Hosted SaaS platform with TypeScript/Python SDKs |
| Eval entry | UI: paste a `(question, chatbot response)` | SDK: `Eval(name, {data, task, scores})`; also playground UI |
| Lifecycle | Single eval → score + rationale | Playground → Experiments (immutable runs) → Production logging → Online scoring → feedback into datasets |
| Strength | Explainability, offline use, guideline-`.md` judging, RAG-generated reference | End-to-end lifecycle, experiment diffing, prompt versioning, production observability, **tools + agents as first-class eval primitives** |
| Differentiator vs DeepEval | (see `improvement-deepeval.md`) | Tools-callable-from-prompts, agent chains in playground, production trace → dataset feedback loop |

Braintrust overlaps with DeepEval on metrics/scorers, but its UX center of gravity is the **playground** (iterate prompts visually, with tools, on real data) and the **experiment** (immutable run you can diff against another run).

---

## 2. The Two Patterns from the Slides

### 2.1 Prompt + Tools

> "A Tool is a reusable function — written in TypeScript or Python — that LLMs can call to perform actions during an eval or interaction."

In Braintrust, Tools are first-class objects:
- Registered once, reusable across prompts
- Called by the model mid-task (fetch data, run code, query a DB, apply business logic)
- Logged per invocation in the trace
- Available in the playground and in SDK evals

**What this means for EvalBot:**

EvalBot's AI judge today is a single LLM call with a fixed prompt. It cannot:
- Look up the live company knowledge base outside the pre-retrieved chunks
- Run a deterministic check (regex, numeric tolerance, date parsing) mid-judgment
- Cross-reference an external API (e.g. policy version, product catalog)
- Verify a claim by re-querying the vector store with a different query

A **Tools layer** would let the judge become more rigorous and explainable.

### 2.2 Agents (chained prompts)

> "Agents in Braintrust allow you to chain together two or more prompts. The output of one prompt becomes the input of the next one."

This is **not** the autonomous-agent / tool-loop pattern — it's a **directed prompt pipeline**, configurable in the playground.

**What this means for EvalBot:**

EvalBot's current judging is a single prompt with everything jammed in (question + response + reference + guideline files + retrieved chunks → JSON of scores + rationale). That works for an MVP but:
- Long prompts dilute attention; per-dimension scores get noisier
- Guideline-violation detection competes with numeric scoring in the same context window
- Hard to A/B-test the *judging pipeline* itself

A **judge agent chain** (e.g. *retrieve-critic → faithfulness-checker → guideline-checker → score-aggregator*) would isolate concerns and let you swap individual stages.

---

## 3. Capability Diff (Braintrust → EvalBot)

| Braintrust capability | Relevance to EvalBot | Tier |
|---|---|---|
| **Tools** (typed Python/TS functions callable by the judge) | High — turns the AI judge from a single LLM call into a tool-using reasoner | T1 |
| **Agent chains** (pipeline of prompts, output→input) | High — decomposes the monolithic judge prompt into stages | T1 |
| **Experiments** (immutable snapshots of a run, with diffing) | High — equivalent to "test suite run" + regression diff (already planned in `improvement-deepeval.md` T1-B) | T1 |
| **Playground** (browser-based prompt iteration on a dataset) | Medium — EvalBot has a paste-in flow; a true playground over a saved suite would be a big UX upgrade | T2 |
| **Autoevals** (built-in scorers library) | Medium — overlaps with what EvalBot already has; selectively port useful ones (Factuality, Answer-Similarity, Battle) | T2 |
| **Online scoring** (async LLM-judge over production traces) | Low for MVP — requires live chatbot integration (currently out of scope) | T3 |
| **Production logging / tracing** | Low for MVP — same reason | T3 |
| **Human review / annotation** with feedback into datasets | Medium — pair with EvalBot's UI: reviewer overrides AI judge, override is logged and used to train weights | T2 |
| **Prompt versioning / registry** | Low — EvalBot's judge prompt is owned by the codebase | T3 |
| **CI/CD integration** (regression on PRs) | Medium — only valuable after Test Suites land (see DeepEval doc T1-B) | T2 |
| **Model comparison** side-by-side | Medium — already planned as "multi-judge mode" | T2 |

---

## 4. Recommended Additions (Braintrust-inspired)

### T1-Bt-A. Tool layer for the AI judge *(2–3 days)*

**Goal:** Let the judge call deterministic functions during evaluation instead of approximating them in-prompt.

**Tool interface:**

```python
# server/app/engines/judges/tools/base.py
class JudgeTool(Protocol):
    name: str
    description: str
    parameters: dict  # JSON schema

    def run(self, **kwargs) -> dict: ...
```

**MVP tool set** (chosen for high-leverage chatbot evaluation):

| Tool | Purpose |
|---|---|
| `retrieve_chunks(query: str, k: int)` | Re-query the project's vector store with a different query — lets the judge verify a specific claim by pulling targeted evidence |
| `regex_extract(text: str, pattern: str)` | Pull entities/numbers from the response without LLM ambiguity |
| `numeric_check(claim: str, allowed_tolerance: float)` | Verify a numeric value against the reference within tolerance |
| `pii_scan(text: str)` | Run deterministic PII detection (emails, phones, CCs, SSNs); returns hits with spans |
| `cite_lookup(claim: str)` | Search retrieved chunks for an exact citation; returns the supporting span or `None` |
| `guideline_search(query: str)` | Search uploaded guideline `.md` files for a matching rule |

**Wiring:**
- Tools registered in `server/app/engines/judges/tools/registry.py`
- Judge prompt now includes a tool schema; provider-specific bindings (Anthropic tool_use, OpenAI function calling, Gemini function calling, Ollama JSON-mode polyfill)
- Each tool call logged into `evaluation.judge_trace` (new column) — visible in the UI under a collapsible "Judge Reasoning" panel

**Why this beats just adding more prompt instructions:**
- Deterministic checks (regex, numeric, PII) become exact instead of approximated
- The judge's reasoning becomes auditable (you see what it looked up)
- Adds zero latency for cases that don't need the tool

### T1-Bt-B. Judge agent chain *(2 days)*

**Goal:** Decompose the monolithic judging prompt into a small pipeline so each stage can be tuned and tested.

**Proposed stages:**

```
┌──────────────────┐   ┌──────────────────────┐   ┌─────────────────────┐   ┌──────────────────┐
│ 1. Decompose     │ → │ 2. Per-claim check   │ → │ 3. Guideline scan   │ → │ 4. Aggregate     │
│ Extract claims   │   │ Each claim against   │   │ Response against    │   │ Combine signals  │
│ from the response│   │ retrieved chunks     │   │ guideline .md files │   │ → per-dim scores │
│ → list[claim]    │   │ → entailment per     │   │ → list of findings  │   │ + rationale       │
└──────────────────┘   └──────────────────────┘   └─────────────────────┘   └──────────────────┘
```

**Implementation:**
- Each stage = a prompt template + a Pydantic output model
- `JudgeChain` orchestrator in `server/app/engines/judges/chain.py`
- Stages can be swapped per project (e.g. some projects skip stage 3 if no guidelines uploaded)
- Each stage's input/output stored in `judge_trace` for debugging

**Benefits:**
- Faithfulness becomes per-claim with quoted evidence — directly comparable to DeepEval's `faithfulness` metric
- Guideline scan no longer competes with scoring in the same prompt — fewer missed violations
- Stages are A/B-testable independently
- Combines well with **T1-Bt-A**: stage 2 uses `retrieve_chunks`, stage 3 uses `guideline_search`, stage 4 uses `pii_scan`

### T1-Bt-C. Experiments view = Test Suite Runs with diffing *(included in DeepEval doc T1-B)*

Already covered in `improvement-deepeval.md` T1-B. Braintrust validates the pattern: name it **Experiments** in the UI (instead of "Runs") to match industry vocabulary if customer-facing.

### T2-Bt-D. Playground mode *(3–4 days, defer to v2)*

**Goal:** Browser-based iteration on a saved test suite, swapping judge prompt / model / weights, comparing results live.

**UI sketch:**
- Left: pick a Test Suite (existing entity from DeepEval doc T1-B)
- Middle: editable judge config (judge prompt, model dropdown, weights, enabled custom metrics, enabled tools)
- Right: live results table — runs every case on Save, diffs against the previous config in the same session

Backed by the same `/api/evaluate` endpoint; just adds in-memory config overrides and a side-by-side diff renderer.

### T2-Bt-E. Human review overrides feeding back into the dataset *(2 days, defer to v2)*

**Goal:** When a reviewer disagrees with the AI judge, log the correction; over time build a labelled set per project that can be used to (a) report judge accuracy and (b) tune weights.

**Data model:**

```python
class ReviewerOverride(SQLModel, table=True):
    id: int
    evaluation_id: int
    reviewer: str  # free-text for now (no auth in MVP)
    dimension: str  # which sub-score was overridden
    judge_score: float
    reviewer_score: float
    reason: str | None
    created_at: datetime
```

**Analytics impact:**
- New tile: "Judge ↔ Reviewer Agreement" (parallel to existing ML ↔ AI agreement)
- Filterable in the Analytics dashboard

---

## 5. Combined Roadmap (DeepEval + Braintrust inputs)

Merging this doc with `improvement-deepeval.md`:

| Order | Item | Source | Effort |
|---|---|---|---|
| 1 | Per-dimension pass thresholds | DeepEval | 0.5–1d |
| 2 | Split metrics: Faithfulness + Contextual Recall + PII | DeepEval | 1–2d |
| 3 | Judge agent chain (decompose → per-claim → guideline → aggregate) | **Braintrust** | 2d |
| 4 | Tool layer for the judge (retrieve, regex, numeric, PII, cite, guideline_search) | **Braintrust** | 2–3d |
| 5 | Test Suites + batch run (= Experiments) | DeepEval | 2–3d |
| 6 | Synthetic question generation from docs | DeepEval | 1d |
| 7 | Custom metrics per project (G-Eval pattern) | DeepEval | 1–1.5d |
| 8 | Playground mode | Braintrust | 3–4d *(v2)* |
| 9 | Human review overrides + agreement analytics | Braintrust | 2d *(v2)* |

**v1 total (items 1–7):** ~10–13 dev-days for combined DeepEval + Braintrust parity on the chatbot-eval use case.

The Braintrust additions (#3, #4) are **architecturally upstream** of the DeepEval ones (#5, #6, #7) — once the judge is a tool-using chain, faithfulness/PII/recall scoring becomes a natural output of the pipeline rather than a separate metric to bolt on.

---

## 6. What EvalBot Should Not Copy from Braintrust

- **Hosted SaaS model** — conflicts with EvalBot's "local-only, restricted-network" pitch.
- **Production logging / online scoring** — requires live chatbot integration; explicitly out of MVP scope.
- **Prompt versioning registry** — overengineered for a single in-repo judge prompt.
- **Org / access control** — no auth in MVP.
- **Autoevals as a separate library** — EvalBot's ML engine already plays this role; don't fork.
