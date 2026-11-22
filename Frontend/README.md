# Frontend

Presentation and interaction only. All durable application data, including
header-bell notifications and their read state, is owned by the backend and
stored in PostgreSQL.

## Two lanes

- **Data:** one GraphQL endpoint. `src/lib/gql.ts` is the only transport;
  `src/app/api.ts` holds every operation (workspace query, YouTube, anime,
  playlists, auth). No REST calls for application data.
- **Bell:** `src/lib/notifications.ts` calls the authenticated backend REST
  API at `GET /notifications` and `POST /notifications/seen`. Both read and
  update the encrypted PostgreSQL `notifications` table. The bell polls that
  API; there is no frontend-owned inbox or second notification store.

## Source map

```text
Frontend/
├── src/
│   ├── app/          App shell, rail/topbar, provider, GraphQL API, UI primitives
│   ├── features/     auth · notifications · management · todo · bell
│   ├── lib/          gql client, notification API client, types, formatting
│   └── styles/       theme tokens + layout/pages
└── Dockerfile        bun build → nginx proxying authenticated APIs to FastAPI
```

## Scripts

```bash
    bun run dev       # Vite proxies application APIs to FastAPI on :8123
npm run check     # tsc --noEmit
npm run build     # production bundle
```

Vite and production nginx proxy `/graphql`, `/auth`, `/admin`, `/yt`, `/ani`,
`/notifications`, and `/health` directly to FastAPI.

## Receiver API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/notifications?limit=` | authenticated newest-first PostgreSQL history |
| POST | `/notifications/seen` | authenticated `{ids, seen}` read-state update |

Notification content is encrypted per user in PostgreSQL. The browser uses its
session cookie; user IDs are derived by the backend, never trusted from query
parameters.

## Package manager: **bun only**

The frontend is installed, checked and built with [bun](https://bun.sh):

```sh
bun install --frozen-lockfile
bun run check   # tsc
bun run build
```

`package-lock.json` was removed (it drifted from `bun.lock`); npm is not a
supported install path. CI enforces the frozen bun install + check + build.
