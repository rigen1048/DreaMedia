# Backend

This directory contains DreaMedia's existing Python/FastAPI/Postgres backend and its runtime assets. The source modules retain their upstream internal structure; the monorepo keeps `/Backend` and `/Frontend` as peers. Frontend work does not add backend database or API code here.

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

`pyproject.toml` and `uv.lock` are the Python dependency source of truth. The Compose file is at the repository root (`../compose.yaml`) and starts local PostgreSQL. `.env.example` lists backend environment keys and contains no live credentials.

## Start the full app

From the repository root:

```bash
chmod +x start.sh
./start.sh
```

The launcher starts PostgreSQL, syncs locked backend/frontend dependencies, and runs FastAPI with Vite. Press `Ctrl+C` to stop the app processes; the database container and its data volume remain in place.

## Run the backend alone

Start PostgreSQL from the repository root, then run FastAPI from this directory:

```bash
# Repository root
docker compose up -d db

# Backend/
cp .env.example .env   # only when .env does not already exist
uv sync --frozen
uv run -m App.main
```

Keep secrets in the local `.env`, never commit it. Run the backend test suite from this directory with `uv run pytest`. The root [`README.md`](../README.md) describes the sibling frontend and one-command startup.
