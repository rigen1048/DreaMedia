#!/usr/bin/env bash
# DreaMedia launcher — idempotent like HydraWatch: run it as many times
# as you want. Each run: backup → full wipe → clean rebuild → start.
# Restore is NEVER automatic (owner decision, D33): the admin restores
# manually through the admin API when needed.
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${ROOT_DIR}/Backend"
FRONTEND_DIR="${ROOT_DIR}/Frontend"
BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/backups}"
STATE_FILE="${ROOT_DIR}/.last-pgpass-sha"

LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
LOCAL_IP=${LOCAL_IP:-127.0.0.1}
HOSTNAME=$(hostname 2>/dev/null || echo localhost)

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ Missing '$1' — install it and rerun ./start.sh"; exit 1; }; }
need uv; need bun; need docker

if [[ ! -f "${ROOT_DIR}/.env" ]]; then
  echo "✗ No .env at the repo root."
  echo "  Fix: cp .env.example .env  → then set DREAMEDIA_PG_PASSWORD"
  exit 1
fi
set -a; source "${ROOT_DIR}/.env"; set +a
: "${DREAMEDIA_PG_PASSWORD:?Set DREAMEDIA_PG_PASSWORD in ${ROOT_DIR}/.env (see .env.example)}"

# Password stability: WARNING only, never enforcement (owner decision).
PASS_SHA=$(printf '%s' "${DREAMEDIA_PG_PASSWORD}" | sha256sum | cut -d' ' -f1)
if [[ -f "${STATE_FILE}" ]] && [[ "$(cat "${STATE_FILE}")" != "${PASS_SHA}" ]]; then
  echo "⚠ WARNING: DREAMEDIA_PG_PASSWORD changed since the last run."
  echo "  The fresh volume will use the new password fine, but we recommend"
  echo "  keeping it stable across runs. Continuing in 5 seconds..."
  sleep 5
fi
printf '%s' "${PASS_SHA}" > "${STATE_FILE}"

echo "=================================================="
echo "🐴 DreaMedia is starting..."
echo "   On this machine : http://localhost:3000"
echo "   From your WiFi  : http://${LOCAL_IP}:3000"
echo "   GraphQL         : http://localhost:8000/graphql"
echo "=================================================="
command -v qrencode >/dev/null 2>&1 && qrencode -t ansiutf8 "http://${LOCAL_IP}:3000" || true

# ---- 1. Backup BEFORE the wipe (restore stays manual, D33) ------------------
mkdir -p "${BACKUP_DIR}"
if docker compose exec -T db pg_isready -U dreamedia >/dev/null 2>&1; then
  STAMP=$(date +%Y%m%d-%H%M%S)
  echo "→ Backing up Postgres → ${BACKUP_DIR}/dreamedia-${STAMP}.dump"
  docker compose exec -T db pg_dump -U dreamedia -Fc dreamedia > "${BACKUP_DIR}/dreamedia-${STAMP}.dump" \
    && echo "  ✓ backup ok" || echo "  ⚠ backup failed — continuing anyway"
  # Retention: keep the newest BACKUP_KEEP_LATEST (floor 2, D2).
  KEEP="${BACKUP_KEEP_LATEST:-5}"; (( KEEP < 2 )) && KEEP=2
  ls -1t "${BACKUP_DIR}"/dreamedia-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
else
  echo "→ No running database to back up (first run or already down)."
fi

# ---- 2. Full teardown (idempotency, HydraWatch style) -----------------------
echo "→ Full teardown: containers, volumes, builder cache..."
docker compose down -v --remove-orphans || true
docker builder prune --all --force >/dev/null 2>&1 || true

# ---- 3. Clean rebuild -------------------------------------------------------
echo "→ Starting fresh Postgres..."
docker compose up -d db
echo "→ Waiting for Postgres..."
for _ in $(seq 1 30); do
  docker compose exec -T db pg_isready -U dreamedia >/dev/null 2>&1 && break
  sleep 1
done

echo "→ Syncing backend deps..."
(cd "${BACKEND_DIR}" && uv sync -q)
echo "→ Starting backend on :8000..."
(cd "${BACKEND_DIR}" && nohup uv run uvicorn App.main:app --host 0.0.0.0 --port 8000 \
  > "${ROOT_DIR}/.backend.log" 2>&1 & echo $! > "${ROOT_DIR}/.backend.pid")

echo "→ Installing frontend deps..."
(cd "${FRONTEND_DIR}" && bun install --silent)

cleanup() {
  echo ""
  echo "→ Stopping backend..."
  kill "$(cat "${ROOT_DIR}/.backend.pid" 2>/dev/null)" 2>/dev/null || true
  rm -f "${ROOT_DIR}/.backend.pid"
  echo "→ Postgres left running (stop: docker compose down). Your backup is in ${BACKUP_DIR}."
  echo "  Restore is manual (D33): POST /admin/restore as admin."
}
trap cleanup EXIT INT TERM

sleep 3
command -v xdg-open >/dev/null 2>&1 && xdg-open "http://localhost:3000" >/dev/null 2>&1 || true

echo ""
echo "✓ Done (Ctrl+C stops frontend + backend)."
echo "=================================================="
cd "${FRONTEND_DIR}" && exec bun run dev
