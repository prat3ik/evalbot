# Contributing to EvalBot

Thanks for helping out! EvalBot is a local-first chatbot evaluation tool
(FastAPI backend + Next.js frontend). Contributions of any size are welcome.

## Quick start
1. Read the [Quickstart](README.md#-quickstart) to run the backend + frontend.
2. Skim [How it works](docs/how-it-works.md) and the [Glossary](docs/glossary.md).
3. Pick a [`good first issue`](https://github.com/prat3ik/evalbot/labels/good%20first%20issue).

## Where things live
- `server/app/` — FastAPI. Routes in `api/`, scoring/RAG/judges in `engines/`, the live
  chatbot connector in `chatbot_client.py`, ORM models in `models.py`.
- `client/` — Next.js (App Router). Components in `components/`, API client in `lib/api.ts`.

## Running tests
The connector core has standalone tests that need **no dependencies**:
```bash
python3 server/test_chatbot_connector.py
```
For the full server, `cd server && uv sync` first.

## Style
- **Python:** `ruff` (run `uv run ruff check` / `ruff format`). Type hints, small functions, match the surrounding code.
- **TypeScript:** `pnpm format` (Prettier) and `pnpm lint`.
- Match the existing patterns — e.g. add a new model provider by extending `PRESETS` in `server/app/chatbot_client.py`.

## Pull requests
- Branch from `main`; keep PRs **small and focused**.
- Describe **what you changed** and **what you verified** (tests run, screenshots for UI).
- Link the issue you're closing (`Closes #123`).
- For larger changes, **open an issue first** to align on direction.

## Reporting bugs / ideas
- Bugs → an issue with steps to reproduce + expected vs actual.
- Ideas / questions → [Discussions](https://github.com/prat3ik/evalbot/discussions).

Be kind and constructive. That's the whole code of conduct. 🙂
