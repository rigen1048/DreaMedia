# DreaMedia

DreaMedia is a media notification and tracking app organized as a two-part monorepo. **`Backend/` and `Frontend/` are siblings**; neither application is nested inside the other. The existing Git repository and history are preserved.

```text
DreaMedia/
├── Backend/       FastAPI service, Postgres access, ingestion, auth, config, tests
├── Frontend/      React/TypeScript application and frontend toolchain
├── compose.yaml   Root-level local PostgreSQL service
├── start.sh       Root Bash launcher for the local app
├── BACKEND_TODO.md
└── README.md
```

The backend is the source of truth for PostgreSQL, authentication/session state, YouTube and Ani ingestion, backend messages, and durable writes. The frontend owns no database, schema, or demo persistence.

## Quick start

Requirements: Docker Compose v2, `uv`, Node.js, and `pnpm`.

```bash
chmod +x start.sh
./start.sh
```

The root launcher starts PostgreSQL from `compose.yaml`, prepares the backend environment file when needed, syncs the locked Python and Node dependencies, and starts FastAPI and Vite together. Open `http://localhost:3000`; backend health is at `http://127.0.0.1:8000/health`. Press `Ctrl+C` to stop the host application processes. The PostgreSQL container and its named data volume stay running, so your data is preserved. To stop only the database container later, use `docker compose down` from the repo root; do not add `-v` unless you intend to delete its data volume.

The root launcher follows the root-level `start.sh` and Compose layout in [HydraWatch](https://github.com/rigen1048/HydraWatch), adapted to DreaMedia's separate Python and Vite development processes. It deliberately does not run destructive volume resets, `docker builder prune`, or dependency-directory deletion.

## Feed and message contract

**Feed and `msg` are separate.** YouTube/Ani Feed data is read through GraphQL at `/graphql` (`ytFeed`, `ytSidebar`, `ytChannels`, `aniEvents`); the frontend does not use REST feed endpoints for this content. Feed seen-state is also changed through the corresponding GraphQL mutations. The top-right bell is for backend-originated HTTP messages only: it reads `/notifications` and acknowledges IDs through `/notifications/seen`. Feed rows are never copied into the bell.

REST remains in use for auth, channel/category management, and Todo progress operations; Ani management metadata also uses the existing REST read model. The backend already has a `Utility.notify.notify()` record helper, but operational call sites still need to wire the alerts that should become bell messages. See [`BACKEND_TODO.md`](BACKEND_TODO.md).

## Run services separately

If the root launcher is not suitable, start the database and backend manually:

```bash
docker compose up -d db
cd Backend
cp .env.example .env   # only when Backend/.env does not already exist
uv sync --frozen
uv run -m App.main
```

In another terminal, start the frontend:

```bash
cd Frontend
pnpm install --frozen-lockfile
pnpm dev
```

Vite proxies `/auth`, `/notifications`, `/yt`, `/ani`, `/admin`, `/graphql`, and `/health` to `http://127.0.0.1:8000` by default. Set `DREAMEDIA_API_TARGET` if the backend listens elsewhere. Production should serve both behind one origin, or the backend owner should configure credentialed CORS and cookies. See [`Frontend/README.md`](Frontend/README.md) for the frontend module map and checks.

## Work modes

The UI has three modes: Notifications, Management, and Todo. Keyboard navigation: `1`, `2`, `3`; `Ctrl/Cmd+K` opens the mode switcher; `/` focuses the current page search. Ani Todo follows the backend's forward-only cursor and season-level completion model instead of inventing arbitrary per-episode history.

## Checks

```bash
cd Backend && uv run pytest
cd ../Frontend && pnpm format:check && pnpm check && pnpm build:static
```
