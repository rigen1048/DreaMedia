# Backend

This directory contains DreaMedia's existing Python/FastAPI/Postgres backend and its runtime assets. The source modules retain their upstream internal structure; the monorepo refactor only moved them beneath `/Backend` so `/Backend` and `/Frontend` are peers. Frontend work does not add backend database or API code here.

## Module map

| Directory | Responsibility |
|---|---|
| `App/` | FastAPI application assembly, lifespan, and dependencies |
| `Auth/` | Login/signup/logout and notification-history routes |
| `Database/` | PostgreSQL schema, queries, stores, and vault |
| `Orchestrator/` | YouTube and Ani feed/access/fetch/filter pipelines |
| `Graphql/` | GraphQL routes and query composition |
| `Config/` | Runtime and hard-coded service configuration |
| `Model/` | Shared data models |
| `Gate/`, `Utility/`, `Admin/` | Infrastructure checks, common helpers, and administration |
| `tests/` | Backend contract, state, filtering, and integration tests |

`pyproject.toml` and `uv.lock` are the Python dependency source of truth. `compose.yaml` starts the existing database service; `.env.example` lists environment keys and contains no live credentials.

## Local setup

```bash
cd Backend
cp .env.example .env
uv sync
docker compose up -d
uv run -m App.main
```

Keep secrets in the local `.env`, never commit it. Run the backend test suite from this directory with `uv run pytest`. The root [`README.md`](../README.md) describes how to start the sibling frontend.
