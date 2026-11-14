# Frontend

Presentation, interaction and one service: the notification receiver. Durable
data, ingestion, auth and notification production remain backend-owned.

## Two lanes

- **Data:** one GraphQL endpoint. `src/lib/gql.ts` is the only transport;
  `src/app/api.ts` holds every operation (workspace query, YouTube, anime,
  playlists, auth). No REST calls for application data.
- **Bell:** `src/lib/bridge.ts` talks only to `/bridge` —
  `GET /api/notifications`, `POST /api/notifications/seen` and an SSE stream.
  Feed rows are never read here, so the bell can only show backend pushes.

## Source map

```text
Frontend/
├── server/notify-bridge.mjs   REST receiver + SSE + JSON inbox (no deps)
├── src/
│   ├── app/          App shell, rail/topbar, provider, GraphQL API, UI primitives
│   ├── features/     auth · notifications · management · todo · bell
│   ├── lib/          gql client, bridge client, types, formatting
│   └── styles/       theme tokens + layout/pages
├── Dockerfile        bun build → nginx (proxies /graphql, /bridge, …)
└── Dockerfile.bridge node:22-alpine running the receiver
```

## Scripts

```bash
npm run dev       # vite on :3000 (proxies API to :8000, bridge to :3100)
npm run bridge    # notification receiver on :3100
npm run check     # tsc --noEmit
npm run build     # production bundle
```

Vite proxies `/graphql`, `/auth`, `/admin`, `/yt`, `/ani`, `/notifications`,
`/health` to `DREAMEDIA_API_TARGET` (default `http://127.0.0.1:8000`) and
`/bridge` to `DREAMEDIA_BRIDGE_TARGET` (default `http://127.0.0.1:3100`).
In production nginx does the same, with buffering disabled for SSE.

## Receiver API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/notifications` | backend push; `X-Dreamedia-Token` when configured |
| GET | `/api/notifications?userId=` | newest-first list + unseen count |
| POST | `/api/notifications/seen` | `{userId, ids}` mark read |
| GET | `/api/notifications/stream?userId=` | SSE live messages |
| GET | `/health` | liveness + subscriber count |

State persists to `.bridge/inbox.json` (configurable via `BRIDGE_STORE`).
