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

The backend remains the source of truth for PostgreSQL, authentication/session state, YouTube and Ani ingestion, notification events, and durable writes. The frontend is a separate package that consumes its typed same-origin REST API through TanStack Query. No second database, frontend-owned schema, Express service, or demo-data persistence is added.

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

The UI has three modes: Notifications, Management, and Todo. Keyboard navigation: `1`, `2`, `3`; `Ctrl/Cmd+K` opens the mode switcher; `/` focuses the current page search. The app displays backend-confirmed state only. Ani Todo follows the backend's forward-only cursor and season-level completion model instead of inventing arbitrary per-episode history.

## Checks

```bash
cd Backend && uv run pytest
cd ../Frontend && pnpm check && pnpm build:static
```

Remaining backend owner decisions are listed in [`BACKEND_TODO.md`](BACKEND_TODO.md).
