# DreaMedia

DreaMedia is a FastAPI/Postgres media-notification and tracking service with a React frontend. The Python backend at repository root remains the authority for sessions, encrypted user data, YouTube/Ani ingestion, notifications, and every durable mutation. The frontend is in [`frontend/`](frontend/) and does not create a second database, Drizzle layer, Express service, demo dataset, or browser persistence layer.

## Layout

The existing backend remains in `App/`, `Auth/`, `Database/`, `Orchestrator/`, `Graphql/`, and `Config/`. The existing Postgres service remains in `compose.yaml`. The keyboard-first React client is isolated in `frontend/`. Its source is organized around a typed REST layer (`frontend/client/src/lib/api.ts`), centralized TanStack Query reads (`frontend/client/src/lib/mediaQueries.ts`), a view adapter (`frontend/client/src/data/MediaContext.tsx`), and the three requested modes: Notifications, Management, Todo.

[`BACKEND_TODO.md`](BACKEND_TODO.md) records only the remaining backend-owner questions. The upstream pull already implements the frontend contracts for URL resolution, stable feed IDs/read state, channel modes/activity, category CRUD, Ani Canon Only/cursor/ranges, notification history, and cookie logout. No backend source/schema is modified by this frontend integration commit.

## Run locally

Start the existing Postgres and FastAPI application using the backend's established workflow. Then run the frontend:

```bash
cd frontend
pnpm install
pnpm dev
```

The Vite server proxies `/auth`, `/notifications`, `/yt`, `/ani`, `/admin`, `/graphql`, and `/health` to `http://127.0.0.1:8000`. Set `DREAMEDIA_API_TARGET` if the API runs elsewhere. For deployment, serve the frontend and FastAPI through one origin, or configure credentialed CORS/cookie policy in the backend/reverse proxy.

## Frontend shortcuts

Use `1`, `2`, and `3` to move between Notifications, Management, and Todo. `Ctrl/Cmd+K` opens the mode switcher; `/` focuses the current page search. The UI only displays state confirmed by the backend. The Ani Todo deliberately models the backend's forward-only cursor and season-level completion, not an invented arbitrary per-episode checklist.

## Checks

```bash
cd frontend
pnpm check
pnpm build:static
```

The static output is `frontend/dist/public`; declared page routes live at `frontend/client/public/manus-routes.json`.
