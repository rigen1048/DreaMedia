#!/usr/bin/env bash
# DreaMedia dev launcher — UX-first, HydraWatch style.
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${ROOT_DIR}/Backend"
FRONTEND_DIR="${ROOT_DIR}/Frontend"

LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
LOCAL_IP=${LOCAL_IP:-127.0.0.1}
HOSTNAME=$(hostname 2>/dev/null || echo localhost)

# ---- friendly checks -------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ Missing '$1' — install it and rerun ./start.sh"; exit 1; }; }
need uv
need bun
need docker

if [[ ! -f "${ROOT_DIR}/.env" ]]; then
  echo "✗ No .env at the repo root."
  echo "  Fix: cp .env.example .env  → then set DREAMEDIA_PG_PASSWORD"
  exit 1
fi
set -a; source "${ROOT_DIR}/.env"; set +a
if [[ -z "${DREAMEDIA_PG_PASSWORD:-}" ]]; then
  echo "✗ DREAMEDIA_PG_PASSWORD is empty in .env (it's required — see .env.example)"
  exit 1
fi

echo "=================================================="
echo "🐴 DreaMedia is starting..."
echo ""
echo "   On this machine : http://localhost:3000"
echo "   From your WiFi  : http://${LOCAL_IP}:3000"
echo "   Backend API     : http://localhost:8000/health"
echo "   GraphQL         : http://localhost:8000/graphql"
echo ""
echo "   Tip: bookmark http://${HOSTNAME}:3000"
echo "=================================================="

if command -v qrencode >/dev/null 2>&1; then
  qrencode -t ansiutf8 "http://${LOCAL_IP}:3000" || true
else
  echo "(tip: install qrencode for a QR code here)"
fi
echo ""

# ---- postgres --------------------------------------------------------------
echo "→ Starting Postgres..."
docker compose up -d db
echo "→ Waiting for Postgres to accept connections..."
for _ in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U dreamedia >/dev/null 2>&1; then break; fi
  sleep 1
done

# ---- backend ---------------------------------------------------------------
echo "→ Syncing backend deps (uv)..."
(cd "${BACKEND_DIR}" && uv sync -q)
echo "→ Starting backend on :8000..."
(cd "${BACKEND_DIR}" && nohup uv run uvicorn App.main:app --host 0.0.0.0 --port 8000 \
  > "${ROOT_DIR}/.backend.log" 2>&1 & echo $! > "${ROOT_DIR}/.backend.pid")

# ---- frontend --------------------------------------------------------------
echo "→ Installing frontend deps (bun)..."
(cd "${FRONTEND_DIR}" && bun install --silent)
echo "→ Starting frontend on :3000..."

cleanup() {
  echo ""
  echo "→ Stopping backend (pid $(cat "${ROOT_DIR}/.backend.pid" 2>/dev/null || echo '?'))..."
  kill "$(cat "${ROOT_DIR}/.backend.pid" 2>/dev/null)" 2>/dev/null || true
  rm -f "${ROOT_DIR}/.backend.pid"
  echo "→ Postgres left running (stop it with: docker compose down)"
}
trap cleanup EXIT INT TERM

sleep 3
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:3000" >/dev/null 2>&1 || true
fi

echo ""
echo "✓ Done. Logs below (Ctrl+C stops the frontend + backend)."
echo "=================================================="
cd "${FRONTEND_DIR}" && exec bun run dev
