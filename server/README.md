# EvalBot Server

FastAPI service for the EvalBot chatbot-evaluation tool.

## Install

```bash
uv sync
cp .env.example .env  # fill in API keys
```

## Run

```bash
uv run uvicorn app.main:app --reload --port 8000
```

The API will be available at <http://localhost:8000> and OpenAPI docs at <http://localhost:8000/docs>.

## Layout

```
app/
  api/            # FastAPI routers (projects, documents, guidelines, evaluate, ...)
  engines/        # ML/NLP, RAG, AI judge dispatchers
    judges/       # one file per AI provider
  config.py       # pydantic-settings
  db.py           # SQLite engine + session
  models.py       # SQLModel tables
  scoring.py      # weighted combination
  main.py         # FastAPI app entrypoint
seed/
  questions.json  # seed question library
```

All runtime data (SQLite DB, Chroma index, uploaded docs/guidelines) lives under `./data/`.
