# DreaMedia backend (D6 docker app)
FROM postgres:17-bookworm AS pgclient
FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

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
