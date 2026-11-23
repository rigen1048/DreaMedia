# DreaMedia Backend Architecture — Restructure Design

Status: **proposal, awaiting owner approval** (same process as Extension/Docs/extension-design.md).
Recorded 2026-11-23 after the owner's review of the current tree.

## 1. Problem

The current backend drifted from the owner's design in four confirmed ways
(evidence per item, verified against `9ab0436`):

### 1.1 Vague user language baked into backend vocabulary: "notification"
"Notification" is a frontend/user word with two different meanings merged into
one — the pull-driven media feed page and the backend-driven bell messages.
The backend uses it everywhere: `Utility/notify.py`, the `notifications`
table, `Auth/notify_router.py`, GraphQL fields, `notify_yt_video`,
`notify_ani_release`, frontend pages, tests.

### 1.2 The media-folder architecture was abandoned
Owner's spec:

```
/Media/Yt
- /Access      # user's write and delete operations
- /Feed        # user's read operation
- /Filter
- /Utility
- /Fetch
- /Config
  - /Hardcoded # hardcoded variables
  - /Model     # pydantic models
- /SQL
  - /user      # used only when the user triggers
  - /process   # used by the backend mechanism itself
    - create.py   # creates all tables required for THIS media
- manager.py   # what triggers the pipeline
- pipeline.py  # the pipeline
```

Reality today:

- `Orchestrator/Yt|Ani` instead of `Media/Yt|Ani`; no `Utility/` inside the
  media; `Config/` and `Model/` sit at Backend root shared across media
  instead of inside each media folder.
- No `SQL/` layer inside the media at all. SQL lives in `Backend/Database/`
  as a flat dump mixing cross-media and media-specific files:
  `db.py / crypto.py / vault.py / leader.py / schema.sql` (cross-media)
  next to `pg_store.py / ani_store.py / card_store.py` (media-specific) and
  `csvio.py / portable.py` (backup processes).
- `Database/` has no subfolder separating admin SQL from init/schema
  bootstrap. One 538-line `schema.sql` creates every table of every media.

Media-specific operations must never live outside the media folder.

### 1.3 Feed vs. backend-driven messages are inverted
Owner's design: two kinds of backend→frontend communication, and only two.

1. **Feed — frontend-driven (pull).** The user opens the feed page; the
   frontend queries the supergraph; the Yt child GraphQL resolves through
   `Media/Yt/Feed/` over `Media/Yt/SQL/user`; the DB state is the story.
2. **Alerts — backend-driven (push).** The backend messages the bell icon on
   unhappy paths only: "We think the channel got deleted", "We cannot access
   the internet", "Last seen video may got deleted". It never sends feed to
   the bell.

Reality today: the pipeline copies **every new video** into the
`notifications` table (`Orchestrator/Yt/pipeline.py` step 4 →
`notify_yt_video`; same for Ani via `notify_ani_release`), and the Bell reads
exactly that table. The bell and the feed page show the same items — both
backend-driven. Meanwhile the pull lane already exists and works: `yt_feed`
reads `yt_videos`, the ani feed reads `ani_events`, trashbin already operates
on those media tables. The `notifications` table is a redundant
backend-driven shadow of the feed.

Additional violation found while tracing: the Bell fetches
`GET /notifications` / `POST /notifications/seen` — a **REST** endpoint
(`Auth/notify_router.py`). The frontend may only talk GraphQL; nothing else.

### 1.4 The fault tolerance was deleted
The owner's original orchestration checked existence on every failure path
and messaged the user:

- fetch failure → `channel_exists()` → "Channel got deleted"
- playlist fetch failure → `playlist_exists()` → "PlayList got deleted" /
  "Playlist Fetcher — issue, report to the dev"
- last_seen not in feed → `video_exists()` → "Last seen Video got deleted"
- no internet → surfaced, not silently swallowed

Current `Orchestrator/Yt/pipeline.py`: fetch failure just bumps a counter
and backs off — no existence checks, no alerts, no `yt_valid` module at all.
`wait_for_internet()` blocks silently forever. The unhappy-path messaging
the design exists for is gone.

## 2. Decisions (owner-confirmed 2026-11-23)

- **Vocabulary: "notification" is purged completely.**
  - Feed = the pull-driven media data (`yt_videos`, `ani_events`). The page
    currently named "Notifications" is the **Feed** page.
  - **Alert** = the backend-driven bell item, unhappy-path only.
    Table `alerts`, module `Utility/alert.py`, producer `send_alert()`,
    GraphQL `alerts` / `markAlertsSeen`. The Bell shows alerts only.
- Git history is kept; we fix forward with verified commits.
- This doc is approved before implementation; then phase-by-phase, one
  verified commit per phase.

## 3. Target tree

```
Backend/
  App/                  # bootstrap, middleware, lifespan (cross-media)
  Auth/                 # login, sessions, vault unlock (cross-media)
  Admin/                # backup/restore/settings/users routers (cross-media)
  Gate/                 # rate gates (cross-media by design: user×media×fetchtype)
  Graphql/              # supergraph + children; a child schema imports its
                        # media's Feed/Access and exposes fields — never SQL
  Utility/              # cross-media only: logs, check_internet, env, alert.py
  Database/             # cross-media data layer ONLY
    db.py               # pool
    crypto.py           # encryption primitives
    vault.py            # in-memory per-user keys
    leader.py           # advisory-lock leadership
    Init/               # schema bootstrap: cross-media tables + calls each
                        # media's SQL/process/create.py — one entry point
    Admin/              # admin SQL: settings, users, sessions
    Backup/             # portable.py, csvio.py (cross-media backup processes)
  Media/
    Yt/
      Access/           # user write/delete ops + Fetch Now (triggers manager.py)
      Feed/             # user read ops (routers; no SQL strings)
      Filter/           # last_seen, scan, time
      Utility/          # yt_valid: channel_exists, video_exists, playlist_exists
      Fetch/            # yt_rss, yt_playlist, yt_random, convert
      Config/
        Hardcoded/      # RANK_INTERVALS, backoff, counters (yt policy numbers)
        Model/          # pydantic: FetchPayload, video model
      SQL/
        user/           # queries run only on user trigger (feed, access, workspace)
        process/        # queries the mechanism runs (claim_due, save_videos,
                        # schedule, counters, imports)
        create.py       # CREATE TABLE for every yt_* table (+ idempotent migrations)
      manager.py        # triggers the pipeline (claims due rows)
      pipeline.py       # the pipeline
    Ani/                # exact mirror of Yt
  Extension/            # stays: it is a second API medium, not a media
```

Rules:

- A media's SQL, models, hardcoded policy, and validity checks never exist
  outside `Media/<m>/`. `Database/` holds only what affects **all** media +
  the process itself (pool, crypto, vault, leadership, init, admin, backup).
- **Trigger-boundary rule — the directory tells you WHO runs it:**
  - `Feed/` + `Access/` — triggered by the user (frontend or extension,
    via GraphQL). Feed = read, Access = mutation. Nothing in here ever runs
    on a schedule.
  - `manager.py` + `pipeline.py` + `SQL/process/` — triggered by the
    backend's own mechanism (scheduler/leader loop). Never invoked by a
    router.
  - `SQL/user/` — runs only when the user triggers (from Feed/Access).
  - **The one sanctioned crossing:** `Access` exposes a **Fetch Now**
    mutation that calls `manager.py` to run the pipeline on demand for the
    user's own subscription (the existing manual random-refresh precedent,
    generalized: user-triggered synchronous pipeline run inside the
    request). The direction is always user → manager, never manager →
    Feed/Access.
- Feed/Access routers contain zero SQL; they call `SQL/user`. The pipeline
  and manager call `SQL/process`. `SQL/user` and `SQL/process` never import
  each other.
- GraphQL children resolve through Feed/Access, never through SQL directly.
- The frontend talks GraphQL only. The `/notifications` REST router is
  deleted; bell alerts move to GraphQL (`alerts`, `markAlertsSeen`).
- Imports use package style only (`uv run -m Media.Yt.pipeline`,
  `from Media.Yt.SQL.user import ...`) — no path tricks, no sys.path
  hacks.

## 4. Feed/Alert split (data flow)

- Pipelines persist feed into media tables exactly as today
  (`yt_videos`, `ani_events`) and **stop** copying feed items into the
  message table. `notify_yt_video` / `notify_ani_release` are deleted.
- `notifications` table → renamed `alerts` (idempotent migration:
  `ALTER TABLE ... RENAME` guarded by `to_regclass`; fresh installs create
  `alerts` directly). Columns unchanged plus `level` stays in payload.
- Alerts are written only by unhappy-path producers via
  `Utility/alert.py::send_alert(user_id, media, kind, ...)`:
  - yt: `channel_deleted`, `playlist_deleted`, `fetcher_rss`,
    `fetcher_playlist`, `fetcher_random`, `last_seen_deleted`, `no_internet`
  - ani: `anilist_unreachable`, `metadata_fetch_failed`, `no_internet`
  - process: `backup_failed`, `restore_gate` events (admin-level alerts)
- Bell = alerts only. Feed page = feed only. Trashbin unchanged (already on
  media tables); opened alerts keep `seen` on the alerts table.

## 5. Fault tolerance restoration (Yt pipeline)

Mirroring the owner's original orchestration, async-adapted:

1. `wait_for_internet()` gains a bounded wait; on timeout the pipeline
   alerts `no_internet` (throttled per user — one alert until connectivity
   returns) and returns `Failure("no-internet")`.
2. Fetch failure → `Media/Yt/Utility/yt_valid.channel_exists(link)`:
   - gone → alert `channel_deleted`, Failure("Deleted:Channel"). Never
     auto-delete (D15).
   - alive, tracking/wordscan → retry RSS up to 3× on HTTP errors (5s
     apart); still failing → alert `fetcher_rss` ("Issue spotted, please
     report to the dev").
   - playlist → `playlist_exists()`: gone → alert `playlist_deleted`;
     alive → alert `fetcher_playlist`.
   - random → alert `fetcher_random`.
3. last_seen "Not Found" → `video_exists(last_seen)`: gone → alert
   `last_seen_deleted`; alive → counter bump and continue (existing
   re-anchor behavior stays).
4. Ani pipeline: AniList fetch failure after retries → alert
   `anilist_unreachable`; entry metadata refresh failure → alert
   `metadata_fetch_failed`. Existence semantics for Ani entries are
   AniList-driven (entry gone from AniList → alert, never auto-delete).

All alerts respect the per-scope notify toggles where applicable
(domain/subdomain/channel mutes gate feed-sourced alerts like
`channel_deleted`; operational alerts like `no_internet` are unconditional).

## 6. Phase build order (one verified commit per phase)

- **Phase 1 — Alert lane + feed/alert split.** Rename
  notifications→alerts end to end (table + migration, `Utility/alert.py`,
  GraphQL `alerts`/`markAlertsSeen`); delete the `/notifications` REST
  router; Bell switches to GraphQL alerts; delete
  `notify_yt_video`/`notify_ani_release` call sites so pipelines stop
  writing feed into alerts. Verify: bell shows only alerts; feed page
  unchanged; pytest + browser walk.
- **Phase 2 — Fault tolerance.** `Media/Yt/Utility/yt_valid` (existence
  checks), bounded internet wait + `no_internet`, unhappy-path alerts in
  both pipelines per §5. Verify: blackbox repro per failure path —
  deleted channel, deleted playlist, deleted last_seen video, no internet —
  each produces exactly one alert and no auto-delete.
- **Phase 3 — Media structure.** `Orchestrator/` → `Media/`; per-media
  `Config/{Hardcoded,Model}` and `Utility/` move in; `SQL/{user,process}`
  split of `pg_store`/`ani_store`/`card_store`; per-media `create.py`;
  `Database/` reorg (`Init/`, `Admin/`, `Backup/`); Access gains the
  **Fetch Now** mutation calling `manager.py` (generalizing the existing
  manual random-refresh). Pure moves behind stable import shims removed in
  the same commit; the full test suite and a browser walk must be green.
- **Phase 4 — Frontend vocabulary purge.** "Notifications" page → "Feed";
  every user-facing and code-level use of notification→feed/alert as
  appropriate; `lib/notifications.ts` → GraphQL alert client. Verify:
  `grep -ri notification` returns only this doc's history section;
  tsc + build + browser walk.

## 7. Explicitly out of scope

- Git history rewrite (owner deferred).
- Any change to the extension's `/ext/graphql` lane beyond renames it
  imports.
- Backup/restore semantics (unchanged: automated creation + retention,
  manual restore).
