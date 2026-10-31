# Frontend

`Frontend/` is a peer of `Backend/`, not a subdirectory of it. This package owns presentation and browser interactions only. It reads and writes durable state through the backend's REST API and uses TanStack Query for fetching, polling, mutation feedback, and cache invalidation.

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
    │   ├── notifications/   Feed, category/mode filters, notification bell
    │   ├── management/      Channel intake, source rows, category controls
    │   ├── todo/            YouTube queues and Ani progress tracking
    │   └── media/           DTOs, selectors, state adapter and query bundle
    └── shared/              HTTP transport, query keys, reusable controls/styles
```

A page should compose small feature components rather than containing API, state model, and every subview in one module. Keep service DTOs distinct from screen view models. TypeScript stays strict and uses no explicit `any`.

## Local development

Start Postgres/FastAPI using [`../Backend/README.md`](../Backend/README.md), then:

```bash
pnpm install
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
