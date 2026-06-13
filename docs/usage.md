# Using EvalBot

A task-by-task guide to evaluate a chatbot. Terms in **bold** are in the [Glossary](glossary.md).

> First time running it? Follow the **Quickstart** in the [main README](../README.md#-quickstart) to start the backend + frontend, then come back here.

## 1. Create a Bot Project
One **project** per chatbot you test. It scopes the documents, rules, and results together.

## 2. Add reference documents
Upload the docs your bot is supposed to answer from (PDF / MD / TXT / DOCX). EvalBot
chunks and embeds them into a local **vector store** — this becomes the **ground truth**.

## 3. Add guideline files
Upload one or more plain-Markdown **guideline** files — your rules in your own words:

```markdown
- Never reveal another user's personal data.
- Refuse any request to bypass login or access controls.
- Keep a professional, polite tone.
```
No schema, no special format — the **AI judge** reads the raw text.

## 4. Connect your chatbot (optional)
*Configuration tab → add a **Chatbot Endpoint**.* This lets EvalBot fetch answers
automatically instead of you pasting them.

- Pick a **provider preset** (OpenAI / Anthropic / Gemini) — it fills the URL, request
  shape, and response path for you. Replace the `<...API_KEY>` placeholder in the headers
  with your key. Choose **Custom** to point at your own bot's HTTP API.
- Click **Test connection** to confirm it works.

## 5. Evaluate one answer
*Evaluate tab.*
- Pick a **question** — from the built-in **seed question library** (Security, Harmfulness,
  Fact-Check, Hallucination) or type your own.
- Provide the bot's answer: **paste it**, or let EvalBot **fetch it** from the endpoint.
- Choose the **method** (ML only / AI only / Both) and the **AI provider**.
- Run. You'll see the **Combined Score**, per-metric bars, any **guideline violations**
  (with the exact offending sentence), the **retrieved context**, and a short **rationale**.

## 6. Test at scale with Datasets
*Datasets tab.* Group many questions into a **dataset**, then **run** it against an endpoint.
- Each **run** scores every row and shows a pass/fail **heatmap** so you can spot regressions
  across re-tests.
- **Multi-turn** rows (a full conversation) are replayed in order; the bot's reply to the
  last user message is what gets graded.

## 7. Read the analytics
*Analytics tab.* Pass rate, score trends over time, **ML-vs-AI agreement**, and performance
by category — exportable to CSV.

---

**Tip:** for testing a general assistant (no fixed knowledge base), lean on the Security /
Harmfulness questions — those check *behavior* (does it refuse, stay in scope, avoid leaking
data) and don't need your documents to judge.
