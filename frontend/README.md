# DreaMedia frontend

This package is the React/TypeScript/Vite interface for the FastAPI service one directory above it. It uses **TanStack Query** to centralize server reads, polling, mutation invalidation, and error handling. `lib/api.ts` owns typed credentialed REST calls, `lib/mediaQueries.ts` owns query keys and the consolidated media read, and `data/MediaContext.tsx` transforms backend DTOs into the page-facing view model. No source uses `any`.

## Commands

```bash
pnpm install
pnpm dev
pnpm check
pnpm build:static
```

`pnpm build:static` writes `dist/public`. Do not add frontend database/schema code, mock content, or local persistent state; durable changes must go through the FastAPI endpoints.

## Backend integration

During development Vite proxies relative browser paths to `DREAMEDIA_API_TARGET` (default: `http://127.0.0.1:8000`). API calls include browser credentials. The supported UI contract covers backend notification history, YouTube subscription/category/feed state, and Ani event/tracking/cursor state. See [`../BACKEND_TODO.md`](../BACKEND_TODO.md) for the remaining backend-owner questions.

## Keyboard flow

`1` Notifications · `2` Management · `3` Todo · `Ctrl/Cmd+K` mode switcher · `/` current page search.
