# Glossary

Plain-English definitions of the terms used across EvalBot.

### Core
- **Bot Project** — a workspace for one chatbot under test; holds its documents, rules, endpoints, and results.
- **Reference document** — a file your bot should answer from (PDF/MD/TXT/DOCX). Used to build the correct answer.
- **Guideline file** — a Markdown file of your rules/policies in plain words. The AI judge reads it as-is.
- **Reference Answer** — the "correct" answer EvalBot generates from your documents + guidelines, to compare the bot against.
- **Ground truth** — the source of correctness: your documents + guidelines (not the model's general knowledge).

### Retrieval (RAG)
- **RAG** — Retrieval-Augmented Generation: fetch relevant text first, then answer using it.
- **Vector store** — a local search index of your documents' meaning, used to find relevant chunks. (EvalBot uses **Chroma**, embedded — no separate server.)
- **Chunk** — a small slice of a document (~a few paragraphs) that gets indexed and retrieved.
- **Embedding** — a numeric fingerprint of text's meaning; similar text → similar numbers. Powers semantic search and similarity.
- **top-k** — the k most relevant chunks pulled for a question.

### Scoring
- **ML/NLP engine** — the math-only scorer (no API calls): similarity, accuracy, completeness, relevance, readability, etc.
- **AI judge / LLM-as-judge** — an LLM that scores the answer per dimension and explains its reasoning.
- **Combined Score** — the final 0–100 score; the average of the ML and AI scores when both run.
- **Pass threshold** — the score at/above which an answer passes (default **75**).
- **Guideline finding / violation** — a rule the answer broke, with the offending sentence quoted and a reason.
- **Evaluator disagreement** — how far the ML and AI scores differ; large gaps are worth a look.
- **Entity agreement** — overlap of named things (people, products, numbers) between the answer and the reference.

### Running tests
- **Chatbot Endpoint** — a saved connection to a live bot's HTTP API (URL, headers/auth, request shape, response path).
- **Provider preset** — a one-click starting config for a known API (OpenAI / Anthropic / Gemini) or a blank **Custom** one.
- **Dataset** — a saved set of test questions for a project.
- **Dataset row** — one test case: a question (+ optional expected answer, tags, or a multi-turn transcript).
- **Run** — one execution of a dataset against an endpoint; produces a pass/fail result per row.
- **Multi-turn** — a test that is a whole conversation, not a single question; the bot's reply to the last user turn is graded.
- **Seed question library** — built-in starter questions grouped by **Security**, **Harmfulness**, **Fact-Check**, and **Hallucination**.
- **Custom check** — your own pass/fail rule layered on top of the built-in metrics.
- **PII** — Personally Identifiable Information (emails, phone numbers, etc.); EvalBot flags leaks of it.
- **Token usage** — how many tokens the bot's API spent on a request (prompt + completion), when the API reports it.

### Question categories
- **Security** — prompt-injection, data-exfiltration, auth-bypass attempts. Correct behavior = refuse / stay in scope.
- **Harmfulness** — toxic or unsafe content probes.
- **Fact-Check** — questions with a verifiable answer (graded against your documents).
- **Hallucination** — out-of-scope/unanswerable questions where the right move is to say "I don't know."
