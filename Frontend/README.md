# Frontend

`Frontend/` is a peer of `Backend/`, not a subdirectory of it. It owns presentation and browser interactions only. Durable data, schema, auth, feed generation, and message production remain backend-owned.

## Feed and msg

**Feed data and backend `msg` are different lanes.** The YouTube/Ani Feed reads through the `/graphql` supergraph (`ytFeed`, `ytSidebar`, `ytChannels`, `aniEvents`); Feed seen-state uses GraphQL mutations. The Frontend does not call REST feed endpoints to populate user-facing Feed rows.

The top-right bell displays only explicit backend-originated messages from HTTP `GET /notifications`; acknowledgements use `POST /notifications/seen`. Feed rows are not converted into messages. REST is used for auth, channel/category management, and Todo state changes. Ani management metadata remains on its existing REST view because it provides richer Todo fields.

## Source map

```text
Frontend/
├── index.html
├── public/manus-routes.json
├── package.json / pnpm-lock.yaml / tsconfig.json / vite.config.ts
└── src/
    ├── app/                 Application composition, routes, providers, shell, shortcuts
    ├── features/
    │   ├── auth/            Login and session flows
    │   ├── notifications/   GraphQL Feed, category/mode filters, HTTP-message bell
    │   ├── management/      Channel intake, source rows, category controls
    │   ├── todo/            YouTube queues and Ani progress tracking
    │   └── media/           DTOs, protocol clients, selectors, queries and state adapter
    └── shared/              HTTP/GraphQL transport, query keys, reusable controls/styles
```

A page composes small feature components rather than containing API, state model, and every subview in one module. Keep service DTOs distinct from screen view models. TypeScript stays strict and uses no explicit `any`.

## Quick start

From the monorepo root, start the database, FastAPI backend, and Vite together:

```bash
chmod +x start.sh
./start.sh
```

For a frontend-only development server, start the backend using [`../Backend/README.md`](../Backend/README.md), then:

```bash
cd Frontend
pnpm install --frozen-lockfile
pnpm dev
```

Vite proxies `/auth`, `/notifications`, `/yt`, `/ani`, `/admin`, `/graphql`, and `/health` to `http://127.0.0.1:8000`. Set `DREAMEDIA_API_TARGET` to use a different backend URL. Browser requests are relative and include cookies.

## Checks

```bash
pnpm format
pnpm format:check
pnpm check
pnpm build:static
```

The static bundle is written to `dist/`; the route manifest is served from `/manus-routes.json`. The app's three work modes are Notifications, Management, and Todo; keyboard controls are `1/2/3`, `Ctrl/Cmd+K`, and `/`.
