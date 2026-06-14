# How EvalBot compares

EvalBot is young and deliberately narrow. The tools below are excellent and mature —
this page is about **picking the right one for the job**, not "winning."

> TL;DR — most LLM-eval tools are **code / CLI / SaaS built for ML engineers**.
> EvalBot is a **local, point-and-click UI** for grading a chatbot against **your own
> docs + written policies**, with a built-in **jailbreak / PII / scope** battery — so a
> PM, QA, or founder can red-team *any* bot on their laptop.

## At a glance

| | **EvalBot** | promptfoo | deepeval | garak | langfuse |
|---|:--:|:--:|:--:|:--:|:--:|
| Primary interface | **Web UI** | CLI / YAML | Python (pytest) | CLI | SaaS / SDK |
| Runs fully local, no account | **✅** | ✅ | ✅ | ✅ | self-host |
| Grades vs **your own docs + rules** | **✅** | partial | partial | ✖ | ✖ |
| Hybrid **ML + LLM-judge** score | **✅** | LLM | LLM | ✖ | LLM |
| Built-in **jailbreak / PII / scope** battery | **✅** | ✅ (red-team) | add-on | ✅ (deep) | ✖ |
| Multi-turn replay | **✅** | ✅ | ✅ | partial | n/a |
| Production **observability** | ✖ | ✖ | partial | ✖ | ✅ |
| Built for | **PM / QA / founder** | engineers | engineers | researchers | platform teams |

## When EvalBot is the right tool
- You want to **see** results in a UI, not write YAML or pytest.
- You're testing a **domain bot** (support, sales, docs) and want it graded against **its own knowledge base + your policies**.
- You need a quick **security pass** (jailbreaks, data/PII leaks, off-topic answers) on *any* chatbot — including ones you don't own (via their API).
- You want everything **on your laptop**, optionally **offline** (Ollama).

## When to reach for the others
- **promptfoo** — you live in the terminal and want prompt/agent testing + red-teaming wired into **CI/YAML**.
- **deepeval** — you want **pytest-style** assertions and metrics inside a Python test suite.
- **garak** — you need a **deep, research-grade** model vulnerability scan.
- **langfuse / opik / phoenix** — you need **production tracing & observability** for a live app.

EvalBot is **complementary**, not a replacement: many teams red-team in EvalBot's UI, then wire the winning checks into promptfoo/deepeval for CI, and watch production in langfuse.
