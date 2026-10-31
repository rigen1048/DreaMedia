# DreaMedia frontend

This React/TypeScript/Vite frontend intentionally owns presentation and client-side interaction only. Durable records belong to the FastAPI/Postgres backend one directory above this folder. Browser requests use `credentials: "include"` and relative paths; Vite proxies them to `DREAMEDIA_API_TARGET` (default: `http://127.0.0.1:8000`) during development.

## Commands

```bash
pnpm install
pnpm dev
pnpm check
pnpm build:static
```

`pnpm build:static` writes `dist/public`. Do not run a separate frontend database or migrate schema from this folder.

## Current contract discipline

The UI uses existing backend operations for authentication, notification/feed reads, YouTube subscription/label/assignment/delete/category activation, and Ani tracking/entry/season updates. It never persists a missing API feature only in browser state. The exact reviewable backend gaps are in the repository root [`BACKEND_TODO.md`](../BACKEND_TODO.md).

## Keyboard flow

`1` Notifications · `2` Management · `3` Todo · `Ctrl/Cmd+K` mode switcher · `/` search.
