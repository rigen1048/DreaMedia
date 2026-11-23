# Contributing to DreaMedia

DreaMedia is the successor to HydraWatch. Contributions should preserve the project’s central promise:

> Give users the convenience of a personal media account without requiring a platform or hosted intermediary to own their media relationship.

## Before contributing

Read:

- [README.md](README.md) for product direction.
- [FEATURES.md](FEATURES.md) for user-visible behavior.
- [PRIVACY.md](PRIVACY.md) for trust boundaries.
- [ARCHITECTURE.md](ARCHITECTURE.md) for system structure.
- `docs/frontend_ux.md` for detailed interaction contracts.

## Product principles

Prefer changes that:

- reduce dependence on platform algorithms;
- preserve the canonical creator/source relationship;
- keep user data portable and user-controlled;
- make attention policy explicit;
- preserve source state and user intent during failures;
- improve the experience without requiring more cloud trust;
- work well for large personal libraries;
- explain state transitions instead of hiding them.

When adding a new media source, preserve the source boundaries used by the backend. A source should have a clear place for access, feed representation, fetching, filtering, pipeline coordination, manager scheduling/recovery, persistence, and notification behavior. Provider-specific details should stay inside the source implementation whenever possible.

Fault tolerance is part of the feature contract. New work should consider duplicate workers, stale claims, process restarts, provider outages, metadata failures, restore windows, and partial progress. A failed enrichment request must not erase a user’s link; a failed provider request must not corrupt the existing library; and a failed background job must have a recoverable state.

### Requirements for new media sources

Adding a media type means adding an orchestration contract, not only a fetcher. The source should define:

- an idempotent persistence path so retries do not duplicate events or damage user state;
- atomic claim, run, and release behavior for scheduled work;
- stale-claim detection and recovery after process termination;
- token- or attempt-aware release so an old worker cannot clear newer work;
- explicit offline and provider-failure behavior, including bounded backoff;
- graceful cancellation and restart recovery;
- behavior during restore or other database maintenance gates;
- a durable last-seen or equivalent cursor that makes resume semantics explicit;
- tests for competing workers, interrupted work, unavailable providers, and repeated retries.

Keep these rules inside the source manager, pipeline, and persistence boundaries. A new source should not require unrelated media types to understand its provider’s errors or scheduling model.

Avoid changes that:

- silently introduce a hosted middleman;
- turn every feature into a recommendation system;
- delete user intent when metadata fetching fails;
- conflate pause, mute, block, seen, completed, and deleted states;
- make normal operations destructive without explicit confirmation;
- require a Google account for core workflows.

## Repository areas

- `Backend/` — FastAPI, GraphQL, stores, encryption, workers, and tests.
- `Frontend/` — React application; durable notification history and read state come from FastAPI/PostgreSQL.
- `Extension/` — Chrome MV3 and Firefox MV2 extension.
- `docs/` — UX documentation and screenshots.
- `qa/` — browser checks and screenshot capture.

## Local setup

```bash
cp .env.example .env
# Set DREAMEDIA_PG_PASSWORD
python3 setup.py --dev
```

Backend dependencies:

```bash
cd Backend
uv sync --frozen
```

Frontend dependencies:

```bash
cd Frontend
bun install --frozen-lockfile
```

## Checks

Frontend:

```bash
cd Frontend
bun run check
bun run build
```

Backend compilation:

```bash
cd Backend
uv run python -m compileall -q App Auth Admin Config Database Extension Gate Graphql Media Model Utility
```

Backend tests:

```bash
cd Backend
uv run pytest
```

The integration suite expects PostgreSQL and uses provider fixtures or live test configuration depending on the test module.

Browser E2E:

```bash
python3 qa/e2e.py
```

The browser suite covers login, categories, source management, anime state, Todo playlists, progress, PostgreSQL-backed bell history/read state, backups/restores, and admin authorization.

## API and schema changes

When changing GraphQL:

1. Update the resolver/schema.
2. Update the frontend client and types.
3. Add or update contract tests.
4. Consider extension compatibility separately. The `/ext/graphql` schema is a stable installed-client boundary.
5. Document user-visible behavior in `FEATURES.md` or `docs/frontend_ux.md`.

When changing the database:

1. Keep migrations idempotent.
2. Preserve existing user data.
3. Add ownership and concurrency tests.
4. Test backup and restore implications.
5. Never make ordinary startup depend on deleting the database volume.

## UX changes

DreaMedia favors direct, explainable interactions:

- Enter commits inline edits where appropriate.
- Escape cancels or closes panels.
- Empty actions explain what is missing.
- Mutations should visibly settle on backend state.
- Destructive actions need clear confirmation.
- Complex state should be available without forcing users to understand implementation details.

If a change modifies a meaningful workflow, update the screenshots or browser checks where practical.

## Security-sensitive changes

For authentication, encryption, extension tokens, backups, restore, cookies, CORS, or notification persistence:

- document the threat model;
- add an ownership or authorization test;
- test failure and recovery paths;
- avoid logging secrets or decrypted user content;
- consider LAN and reverse-proxy deployment;
- call out whether portable exports contain readable data.

## Commit and pull request guidance

A useful pull request should explain:

- what user problem it solves;
- which product surface changes;
- how privacy or trust boundaries are affected;
- how failure and recovery behave;
- how it was tested;
- whether documentation changed.

Screenshots or a short recording are valuable for frontend changes.

## Good first contribution areas

- Improve empty states and first-run explanations.
- Add provider health and operational notifications.
- Improve migration previews and conflict handling.
- Add server-side pagination for large feeds.
- Improve extension packaging and update guidance.
- Add integration tests to CI with PostgreSQL and provider fixtures.
- Improve terminology and accessibility.
- Add admin audit history and session management.
