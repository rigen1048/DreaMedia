# DreaMedia backend (D6 docker app)
FROM postgres:17-bookworm@sha256:837bed18782820fe967067cb5328b02b0d9992c1be9a37ee0c9c492cfc03af3b AS pgclient
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS base
COPY --from=ghcr.io/astral-sh/uv:latest@sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d /uv /usr/local/bin/uv

# pg_dump/pg_restore 17 — backups and restores run INSIDE this container,
# and the client major must match the pg17 server. Instead of the PGDG apt
# repo (flaky in builds), copy the binaries from the official postgres:17
# image (same glibc/bookworm userland) and install only libpq5 + compression
# libs from stock apt.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq5 liblz4-1 libzstd1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=pgclient /usr/lib/postgresql/17/bin/pg_dump /usr/local/bin/pg_dump
COPY --from=pgclient /usr/lib/postgresql/17/bin/pg_restore /usr/local/bin/pg_restore

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . .
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

# Admin backups default to the relative "backups" directory; the compose
# volume lives at /backups, so make the relative path resolve there.
RUN mkdir -p /backups && ln -s /backups /app/backups
EXPOSE 8000
# Single worker BY DESIGN: sessions, vault keys, restore gates and rate
# gates are process-local (documented single-process home-server model).
CMD ["uvicorn", "App.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
