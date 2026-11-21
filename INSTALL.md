# DreaMedia Installation Guide

Use [FEATURES.md][features] as the companion guide after installation; it explains the source modes, notification scopes, queues, and resilience behavior this setup enables.

DreaMedia is a self-hosted application. The recommended deployment uses Docker Compose for PostgreSQL, the backend, the notification bridge, and the frontend.

## Requirements

### Default Docker stack

- Docker Engine.
- Docker Compose v2.
- Python 3.10 or newer.
- Git, if cloning the repository.

### Local development mode

- Docker for PostgreSQL.
- `uv`.
- Bun.
- Node.js 20 or newer.
- Playwright and Chromium for browser E2E checks.

## Install from Git

```bash
git clone https://github.com/rigen1048/DreaMedia.git
cd DreaMedia
```

## Configure the environment

```bash
cp .env.example .env
```

Set a strong PostgreSQL password:

```dotenv
DREAMEDIA_PG_PASSWORD=replace-with-a-long-random-password
```

The launcher can generate a bridge token when one is not supplied. For a controlled deployment, set one explicitly:

```dotenv
FRONTEND_NOTIFY_TOKEN=replace-with-a-long-random-token
```

## Start the application

```bash
python3 setup.py
```

The default stack exposes:

- Frontend: `http://localhost:8124`
- Backend health: `http://localhost:8123/health`
- GraphQL: `http://localhost:8123/graphql`

The first account created through the web UI becomes an administrator.

> **Important lifecycle note:** the current launcher performs a backup and clean rebuild before starting the application. Review `setup.py` and keep verified dumps before using it with valuable data. Ordinary startup should eventually become non-destructive; until then, treat the launcher as an explicit reset/rebuild workflow.

## Development mode

```bash
python3 setup.py --dev
```

This mode runs PostgreSQL through Docker and starts the bridge, backend, and Vite frontend locally.

## Demo data

After the stack is running:

```bash
docker compose exec backend python scripts/seed_demo.py
```

For local development:

```bash
cd Backend
DREAMEDIA_PG_PASSWORD=... .venv/bin/python scripts/seed_demo.py
```

The demo creates the `demo / demo1234` account and sample YouTube sources, categories, playlists, anime entries, and bell messages.

Do not use the demo password for a real installation.

## Access modes

The `ACCESS` variable controls the published bind address:

```dotenv
ACCESS=computer
```

`computer` binds to localhost. For trusted home-LAN access:

```dotenv
ACCESS=wifi
```

When using LAN access, put DreaMedia behind a trusted reverse proxy with TLS where practical. Do not expose the development ports directly to the public internet.

## Extension setup

1. Open DreaMedia and go to Settings → Extension.
2. Issue an extension token and copy it. The raw token is shown once.
3. For Chrome/Edge/Brave, open `chrome://extensions`, enable Developer mode, and load `Extension/mv3/` as an unpacked extension.
4. For Firefox, open `about:debugging#/runtime/this-firefox`, choose Load Temporary Add-on, and select `Extension/mv2/manifest.json`.
5. Enter the DreaMedia backend URL and extension token in the popup.
6. Add only the media domains on which you want the extension to operate.

Read [Extension/README.md](Extension/README.md) for extension-specific behavior.

## Backups and restore

DreaMedia has two different backup concepts:

### Portable user export

Use Settings for a personal export that can survive schema changes and be imported into another DreaMedia instance. This export contains readable user data, so protect the file like a private document.

### PostgreSQL dump

Administrators can create a database dump from Admin → Backups. Dumps are validated before they are accepted. Restore is destructive and includes a pre-restore snapshot and tracked status.

Keep more than one backup and store at least one copy outside the application directory.

## Update procedure

For an existing Git checkout, run:

```bash
python3 setup.py update
```

The update command requires a clean Git worktree and Docker mode. It stops running Docker app services, creates and validates a PostgreSQL dump, runs `git pull --ff-only`, rebuilds the extension files, restarts the database without deleting the `pgdata` volume, restores the verified dump, then rebuilds and starts the app. It never pushes or rebases local commits. A divergent branch or local work makes the command stop rather than overwrite anything.

If backup creation or the Git pull fails before the database restart, the previously running app services are restarted when possible. If automatic restore fails, the app services remain stopped, the PostgreSQL volume is preserved, and the verified dump remains in `backups/` for recovery. Check `/health`, sign in, and verify the feed and Admin pages after a successful update.

The plain `python3 setup.py` command remains the existing reset workflow: it removes volumes and leaves the database empty for manual restoration. Use `python3 setup.py update` for normal updates; do not delete the PostgreSQL volume as part of a normal update.

## Stop the stack

```bash
docker compose down
```

This stops containers while preserving the named PostgreSQL volume. Avoid `docker compose down -v` unless you intentionally want to delete the database volume and have a verified backup.

## Troubleshooting

### The frontend is unavailable

```bash
docker compose ps
docker compose logs --tail=100 frontend backend bridge
```

### The backend cannot connect to PostgreSQL

```bash
docker compose logs --tail=100 db
```

Check that `DREAMEDIA_PG_PASSWORD` matches the password used when the PostgreSQL volume was initialized.

### The notification bell is empty

Check the bridge health endpoint through the frontend:

```text
http://localhost:8124/bridge/health
```

Confirm that `FRONTEND_NOTIFY_TOKEN` is the same for backend and bridge.

### Source metadata is missing

A source may still be stored even when title or thumbnail enrichment fails. Use Fetch now after checking external provider reachability. The original link remains the source of truth.

### Extension cannot connect

Confirm:

- backend URL has no trailing path beyond the server base;
- the extension token has not been revoked or rotated;
- the relevant domain is enabled in Settings → Extension;
- the backend is reachable from the browser;
- the browser has permission to run the extension on that site.

## Health checks

```bash
curl http://localhost:8124/health
curl http://localhost:8123/health
```

The application health response should return `{"ok":true}`.


[features]: FEATURES.md "DreaMedia feature guide"
[install]: INSTALL.md "DreaMedia installation guide"
