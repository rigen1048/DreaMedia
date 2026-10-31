# DreaMedia

DreaMedia is a media notification and tracking application. The existing Python/FastAPI service owns authentication, encrypted Postgres data, YouTube/Ani ingestion, and every durable mutation. The React client lives in [`frontend/`](frontend/) and communicates only through that API; it has no browser database, Drizzle layer, Express service, or demo-data fallback.

## Repository layout

- `App/`, `Auth/`, `Database/`, `Orchestrator/`, `Graphql/`, `Config/` — existing FastAPI backend and domain code.
- `compose.yaml` — existing local PostgreSQL service.
- `frontend/` — React + TypeScript + Vite client with the three user modes: Notifications, Management, and Todo.
- [`BACKEND_TODO.md`](BACKEND_TODO.md) — frontend contract gaps for backend-owner review. It is not an implementation request and no backend source/schema has been changed in this frontend commit.

## Run locally

Start the existing Postgres service and FastAPI application following the backend project's established instructions. Then run the frontend separately:

```bash
cd frontend
pnpm install
pnpm dev
```

The Vite development server proxies the API paths (`/auth`, `/yt`, `/ani`, `/admin`, `/graphql`, and `/health`) to `http://127.0.0.1:8000` by default. Set `DREAMEDIA_API_TARGET` if FastAPI runs elsewhere. In production, place the frontend and existing API behind one origin, or configure credentialed CORS/cookie policy in the backend/reverse proxy.

## Frontend interaction model

Use `1`, `2`, and `3` for Notifications, Management, and Todo. `Ctrl/Cmd+K` opens the compact mode switcher; `/` focuses page search. The UI only exposes state which the current FastAPI contract can read or write. For example, Ani season watched status and last-watched episode are persisted; current YouTube video seen state is displayed but remains read-only until its backend write route exists.

## Checks

```bash
cd frontend
pnpm check
pnpm build:static
```

The front end's required route manifest is at `frontend/client/public/manus-routes.json`.
