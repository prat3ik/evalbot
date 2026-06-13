# EvalBot ← DeepEval — Improvement Plan

A comparison between EvalBot (Alphabin internal, MVP) and **DeepEval** (github.com/confident-ai/deepeval), with a prioritized list of features worth adopting.

Sources:
- DeepEval docs: https://www.deepeval.com/docs
- DeepEval repo: https://github.com/confident-ai/deepeval (modules in `deepeval/`: `metrics/`, `benchmarks/`, `integrations/`, `simulator/`, `synthesizer/`, `red_teaming/`, `optimizer/`, `tracing/`, `dataset/`, `prompt/`, `annotation/`, `confident/`, `cli/`)
- EvalBot: `./README.md`, `./EvalBot.txt`

---

## 1. Positioning Diff

| | **EvalBot** | **DeepEval** |
|---|---|---|
| Audience | Product/QA teams testing a specific chatbot grounded in company docs + guidelines | LLM/AI engineers building any LLM app |
| Form factor | Web app (Next.js + FastAPI), local-only, no auth | Python SDK + CLI + optional cloud (Confident AI) |
| Eval entry | UI: paste a `(question, chatbot response)` | Code: `evaluate([LLMTestCase(...)], metrics=[...])` |
| Ground truth | Auto-generated from project RAG corpus + guideline `.md` files | Caller supplies `expected_output` and/or `retrieval_context` per test case |
| Metric model | Fixed 5 dimensions + weighted sum + AI rationale | 40+ pluggable metrics, each 0–1 with a threshold; pass/fail per metric |
| Scope | Single-turn paste-in; chatbot-against-company-docs | Single-turn, multi-turn, agentic, multimodal, RAG, benchmarks, red-teaming |
| Differentiators | Free-form guideline-`.md` judging, RAG-generated reference, ML+AI dual engine w/ agreement signal, end-user UI | Breadth of metrics, framework integrations, benchmarks, synthetic data, red-teaming, tracing, CI/CD |

EvalBot is **opinionated and end-user-facing**. DeepEval is a **developer toolkit**. The overlap is the "LLM-as-judge + metric engine" core.

---

## 2. Feature Diff (what DeepEval has that EvalBot doesn't)

### 2.1 Metrics catalog (full inventory from `deepeval/metrics/`)

**Custom / general-purpose**
- `g_eval` — natural-language criterion → LLM judge
- `dag` — decision-tree LLM-as-a-judge for mixed objective criteria
- `arena_g_eval` — pairwise comparison
- `conversational_g_eval`, `conversational_dag` — multi-turn variants
- `exact_match`, `pattern_match` — deterministic
- `json_correctness` — schema-valid JSON
- `ragas` — RAGAS-style aggregate
- `summarization`
- `prompt_alignment`

**RAG (retriever)**
- `contextual_precision`
- `contextual_recall`
- `contextual_relevancy`

**RAG (generator)**
- `answer_relevancy`
- `faithfulness`
- `hallucination`

**Agentic**
- `task_completion`
- `tool_correctness`, `tool_use`
- `argument_correctness`
- `plan_adherence`, `plan_quality`
- `step_efficiency`
- `goal_accuracy`
- `topic_adherence`
- `mcp`, `mcp_use_metric` — for MCP-based agents

**Conversational (multi-turn)**
- `knowledge_retention`
- `role_adherence`
- `conversation_completeness`
- `turn_relevancy`
- `turn_faithfulness`
- `turn_contextual_precision` / `recall` / `relevancy`

**Safety / red-team**
- `bias`
- `toxicity`
- `pii_leakage`
- `misuse`
- `non_advice`
- `role_violation`

**Multimodal** (under `multimodal_metrics/`)
- Image coherence, helpfulness, reference, text-to-image alignment, image editing

EvalBot ships **5 dimensions** (Similarity / Accuracy / Completeness / Relevance / Readability) plus a ML sub-metric pack (toxicity, sentiment, numeric/factual consistency, length).

### 2.2 Mapping EvalBot dimensions to DeepEval

| EvalBot dimension | DeepEval equivalent(s) | Gap |
|---|---|---|
| Similarity (35%) | No direct match — closest is GEval w/ "semantic similarity" criterion | DeepEval treats similarity as a means, not a metric. 35% weight in EvalBot is unusually high vs. modern practice. |
| Accuracy (25%) | `faithfulness` + `hallucination` | EvalBot conflates "matches reference" with "grounded in context." DeepEval splits them. |
| Completeness (25%) | `contextual_recall`, `summarization`, `conversation_completeness` | EvalBot's single metric maps to ≥3 distinct DeepEval concerns. |
| Relevance (10%) | `answer_relevancy`, `contextual_relevancy`, `turn_relevancy`, `conversation_relevancy` | EvalBot collapses retriever / generator / turn / conversation relevance into one. |
| Readability (5%) | (none) | **EvalBot-unique**, useful for non-technical chatbot audiences — keep it. |
| Guideline compliance (unweighted) | `role_adherence`, `misuse`, `non_advice`, `role_violation`, `prompt_alignment` | EvalBot's free-form `.md` judging covers ground DeepEval splits into ~5 metrics. EvalBot wins on UX; DeepEval wins on score-ability. |

### 2.3 Categories EvalBot is completely missing

| Category | DeepEval has | Why it matters |
|---|---|---|
| RAG retriever quality | Contextual Precision/Recall/Relevancy | EvalBot generates a reference answer from RAG but never scores retrieval. If retrieval is bad, every downstream score is suspect. |
| Faithfulness vs Hallucination (split) | `faithfulness`, `hallucination` | #1 enterprise concern for company-doc-grounded chatbots. |
| Safety as scored dimensions | `bias`, `toxicity`, `pii_leakage`, `misuse`, `non_advice` | EvalBot has a toxicity sub-metric and a Security seed category, but no scored bias / PII / misuse. PII is a frequent enterprise blocker. |
| Multi-turn / conversational | All `turn_*` and `conversation_*` metrics | EvalBot is single-turn-only. Most production chatbots are conversational. |
| Agentic | `task_completion`, `tool_correctness`, etc. | Out of MVP scope, but flag for v2 if any client bot uses tools. |
| Structured output | `json_correctness`, `prompt_alignment` | Relevant if the bot returns slots/forms. |
| User-defined metrics | `g_eval`, `dag`, `arena_g_eval` | EvalBot's 5 dimensions are hard-coded — no way for a project to add "Cites a source URL" without code changes. |

### 2.4 Beyond metrics — capabilities EvalBot has no equivalent of

| DeepEval module | Capability | Relevance to EvalBot |
|---|---|---|
| `dataset/` + `Golden` test cases | First-class datasets; iterate, version, reuse | **High** — directly addresses EvalBot's biggest gap: it's a one-shot tool, not a regression harness. |
| `synthesizer/` | Generate synthetic test cases from documents (incl. context, expected output, evolutions) | **High** — EvalBot already indexes docs; auto-seeding a test suite is a strong UX win. |
| `simulator/` | Simulate full multi-turn user conversations against a chatbot | Medium — interesting v2; would require live chatbot integration which is currently out of scope. |
| `red_teaming/` (now standalone "DeepTeam") | Adversarial attack generation (jailbreaks, injections, leakage probes) | Medium — extends EvalBot's existing Security/Harmfulness seed categories with auto-mutation. |
| `benchmarks/` (17+: MMLU, HellaSwag, BBH, GSM8K, HumanEval, BoolQ, ARC, BBQ, DROP, IFEval, LAMBADA, LogiQA, MathQA, SQuAD, TruthfulQA, Winogrande, EquityMedQA) | Run standard academic benchmarks against any LLM | **Low for EvalBot's stated scope** — EvalBot tests *a deployed chatbot*, not the underlying LLM. Skip. |
| `optimizer/` | Sweep prompt/hyperparam variants on a dataset | Medium — useful for "Claude vs Gemini for our support bot" demos. |
| `tracing/` (`@observe`) | Component-level evaluation via execution traces | Low for MVP — EvalBot's premise is paste-in, not live integration. |
| `prompt/` | Prompt versioning/registry | Low — out of scope. |
| `annotation/` | Human-in-the-loop annotation flows | Medium — could pair well with EvalBot's UI: let a reviewer override AI judge scores and log corrections. |
| `cli/` (`deepeval test run`) | Pytest-compatible CLI runner; non-zero exit on failure | **High** — once test suites exist, a CLI runner drops EvalBot straight into a client's CI. |
| `integrations/` (LangChain, LlamaIndex, CrewAI, PydanticAI, Google ADK, HuggingFace, AgentCore, Strands, OpenInference) + native `anthropic/`, `openai/`, `openai_agents/` wrappers | First-class framework hooks | Low for MVP — paste-in flow sidesteps this. Worth knowing for v2 live integration. |
| `confident/` | Cloud platform (Confident AI) for hosted observability, team sharing, regression dashboards | N/A — EvalBot is intentionally local-only. |
| Threshold-per-metric + `strict_mode` + `async_mode` | Each metric pass/fails against its own threshold; suite passes only if all pass | **High** — replaces EvalBot's single global `final_score >= 75` gate. |
| Result caching | Re-running an unchanged input is instant | Medium — EvalBot already caches reference answers; extend to full evaluations. |

---

## 3. Features EvalBot has that DeepEval doesn't (keep & lean into)

- **Guideline-`.md`-aware judging** — no DeepEval equivalent of "read these free-form policy files and flag violations with quoted spans." This is EvalBot's strongest differentiator. **Make it more prominent in the UI.**
- **Auto-generated reference answer from RAG** — DeepEval requires callers to write `expected_output`. EvalBot's zero-config ground truth is a real edge for non-technical users.
- **ML + AI dual-engine with agreement signal** — DeepEval is LLM-judge-first. Surfacing inter-engine disagreement is genuinely novel.
- **End-user web UI** — DeepEval is SDK-first; non-engineers can't really use it.
- **Readability as a first-class score** — DeepEval has nothing here.
- **Local-only, no Docker, no cloud** — concrete pitch for restricted-network enterprise clients.

---

## 4. Recommended Additions (Prioritized)

### Tier 1 — Adopt for v1 (high ROI, fits current architecture)

#### T1-A. Per-dimension pass thresholds *(0.5–1 day)*

Replace single `final_score >= 75` with per-dimension thresholds; pass = AND across thresholded dimensions.

```python
class ProjectThresholds(SQLModel, table=True):
    project_id: int  # PK
    similarity: float = 0.0          # 0 = no gate
    accuracy: float = 0.0
    completeness: float = 0.0
    relevance: float = 0.0
    readability: float = 0.0
    faithfulness: float = 0.7        # if T1-D adopted
    pii_leakage: float = 1.0         # binary — any leak = fail
    combined: float = 0.75
```

Evaluation result gains a `pass_breakdown` with per-dimension `{score, threshold, passed}` and `failing_dimensions`. UI: settings tab per project; corner pass/fail badges on each score tile; Analytics "Pass Rate" tile reflects multi-dimensional pass with a stacked "failed on" bar.

#### T1-B. Test Suites + batch run *(2–3 days)*

Turn EvalBot from a one-shot scorer into a regression harness — the single biggest functional gap vs. DeepEval.

```python
class TestSuite(SQLModel, table=True):
    id: int
    project_id: int
    name: str
    created_at: datetime

class TestCase(SQLModel, table=True):
    id: int
    suite_id: int
    question: str
    expected_response: str | None
    expected_to_refuse: bool = False
    tags: list[str]

class SuiteRun(SQLModel, table=True):
    id: int
    suite_id: int
    bot_responses: dict[int, str]
    started_at: datetime
    completed_at: datetime | None
    summary: dict
```

API:
- `POST /api/projects/{id}/suites`
- `POST /api/suites/{id}/cases` (single or CSV bulk)
- `POST /api/suites/{id}/runs` — start a run with `{case_id: response}`
- `GET /api/suites/{id}/runs/{rid}/diff/{prev_rid}` — regression diff

UI: new sidebar item "Test Suites"; run page = 3-column table (question, expected, paste-area); results = pass-rate tile, sortable case table, click-into-case shows the existing eval card; regression diff view ("3 newly failing, 1 newly passing").

#### T1-C. Synthetic question generation from documents *(1 day)*

Mirrors DeepEval's `synthesizer/`. After doc upload, one click → ~20 proposed test questions across categories: **factual**, **edge** (unanswerable, bot should say "I don't know"), **adversarial** (probes guideline-forbidden topics), **multi-hop** (combines chunks).

Backend: sample diverse chunks (cluster on embeddings), prompt the judge with chunks + guideline files, return JSON `[{question, expected_response, category, expected_to_refuse}]`. Frontend: modal with checkboxes → "Add Selected to Suite."

#### T1-D. Split metrics: Faithfulness + Contextual Recall + PII Leakage *(1–2 days)*

Close the biggest credibility gap vs. DeepEval by splitting EvalBot's overloaded dimensions:

- **Faithfulness** — % of claims in the response entailed by retrieved chunks. Already feasible with existing chunks + judge.
- **Contextual Recall** — did retrieval pull in everything needed? Diagnoses bad indexing vs. bad generation.
- **PII Leakage** — regex pass (emails, phones, CCs, SSNs) + LLM judge over response. High enterprise value, cheap.

Proposed weight rebalance:

| Dimension | Old | Proposed |
|---|---|---|
| Faithfulness *(new)* | — | 25% |
| Answer Relevancy *(renamed from Relevance)* | 10% | 20% |
| Contextual Recall *(new)* | — | 15% |
| Accuracy (vs reference) | 25% | 15% |
| Similarity | 35% | 10% |
| Completeness | 25% | (subsumed by Recall) |
| Readability | 5% | 5% |
| Safety (PII / Toxicity) | — | pass/fail gate, not weighted |

Cleaner story: "quality is weighted; safety is pass/fail."

#### T1-E. Custom metrics per project (G-Eval pattern) *(1–1.5 days)*

```python
class CustomMetric(SQLModel, table=True):
    id: int
    project_id: int
    name: str                       # "Cites a source URL"
    description: str                # NL criterion
    evaluation_steps: list[str]     # optional
    weight: float = 0.0             # 0 = informational only
    threshold: float = 0.7
    enabled: bool = True
```

Judge prompt addendum returns `{score, reason, passed}` per custom metric. UI: "Custom Metrics" tab on Bot Project; results render in their own card under AI Details.

### Tier 2 — v2 candidates

| Item | DeepEval equivalent | Effort | Value |
|---|---|---|---|
| CLI runner (`evalbot run --suite X --responses bot.csv --fail-on regression`) | `deepeval test run` | 1d | Enables CI use after T1-B lands |
| Adversarial seed-question mutation (jailbreaks, injections from a base question) | `red_teaming/` | 1–2d | Extends existing Security/Harmfulness seed categories |
| Multi-turn / conversational mode (paste a `[user, bot, user, bot, ...]` sequence) | `turn_*` + `conversation_*` metrics | 3–4d | Real production chatbots are conversational |
| Side-by-side comparison view (same questions, different bot / model) | `optimizer/` + multi-judge mode you already planned | 1–2d | Strong sales-demo capability |
| Human-in-the-loop annotation overrides (reviewer can correct AI judge scores) | `annotation/` | 2d | Builds an internal labelled dataset over time; also a moat |
| Result caching keyed on `(project, question, response, judge_model)` | DeepEval cache | 0.5d | Iterative dev speed |

### Tier 3 — Out of scope / skip

- Standard LLM benchmarks (MMLU, HellaSwag, ...) — EvalBot tests *a deployed chatbot*, not the underlying LLM.
- Framework integrations (LangChain/LlamaIndex/CrewAI/etc.) — paste-in flow sidesteps these.
- Component-level tracing (`@observe`) — would require live chatbot integration, currently locked out of MVP.
- Cloud platform (Confident AI parity) — conflicts with the "local-only, restricted-network friendly" pitch.

---

## 5. Suggested Sequencing

| Order | Item | Effort | Unlocks |
|---|---|---|---|
| 1 | T1-A — Per-dimension thresholds | 0.5–1d | Honest pass-rate metric; foundation for everything else |
| 2 | T1-D — Faithfulness + Contextual Recall + PII split | 1–2d | Closes biggest credibility gap vs. DeepEval |
| 3 | T1-B — Test Suites + batch run | 2–3d | Turns demo tool into a regression harness (DeepEval-parity feature) |
| 4 | T1-C — Synthetic question generation | 1d | Removes cold-start friction; great demo moment |
| 5 | T1-E — Custom metrics per project | 1–1.5d | Long-tail extensibility per client |

**Total: ~6–9 dev-days** to reach meaningful DeepEval parity while keeping EvalBot's UX advantages (RAG-generated reference, guideline-`.md` judging, paste-in flow, ML+AI dual engine).

---

## 6. Open Questions (carry over from README)

1. **Default AI judge provider** — Claude vs Gemini vs OpenAI vs Ollama. Multi-judge mode in MVP or v2?
2. **Guideline violation impact on score** — reduce score via existing weights, or sit as a separate Findings panel? DeepEval pattern would be: tag each finding `minor / major / critical`, treat `critical` as a pass/fail gate (like PII), `major / minor` as weighted deductions.
3. **"Entity agreement" tile** — best guess remains: overlap of named entities (people, products, numbers) between chatbot response and reference. Confirm or replace.
4. **New:** should T1-B Test Suites support **shared / public suites** across projects (e.g. an Alphabin-curated "Standard Safety Suite" any project can attach)?
