# DreaMedia

DreaMedia is a media notification and tracking app organized as a two-part monorepo. **`Backend/` and `Frontend/` are siblings**: the frontend is not nested inside the backend.

```text
DreaMedia/
├── Backend/       FastAPI service, Postgres access, ingestion, auth, config, tests
├── Frontend/      React/TypeScript application and frontend toolchain
├── BACKEND_TODO.md
├── README.md
└── .gitignore
```

The backend is the source of truth for PostgreSQL, authentication/session state, YouTube and Ani ingestion, backend messages, and durable writes. The frontend owns no database, schema, or demo persistence.

## Feed and message contract

**Feed and `msg` are separate.** YouTube/Ani Feed data is read through GraphQL at `/graphql` (`ytFeed`, `ytSidebar`, `ytChannels`, `aniEvents`); the frontend does not use REST feed endpoints for this content. Feed seen-state is also changed through the corresponding GraphQL mutations. The top-right bell is for backend-originated HTTP messages only: it reads `/notifications` and acknowledges IDs through `/notifications/seen`. Feed rows are never copied into the bell.

REST remains in use for auth, channel/category management, and Todo progress operations; Ani management metadata also uses the existing REST read model. The backend already has a `Utility.notify.notify()` record helper, but operational call sites still need to wire the alerts that should become bell messages. See [`BACKEND_TODO.md`](BACKEND_TODO.md).

## Start the backend

Follow the backend guide in [`Backend/README.md`](Backend/README.md). Backend Python project configuration, lockfile, Compose file, environment example, source modules, and tests live together under `Backend/`.

## Start the frontend

Start FastAPI/Postgres first, then:

```bash
cd Frontend
pnpm install
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
