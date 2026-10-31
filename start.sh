#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${ROOT_DIR}/Backend"
FRONTEND_DIR="${ROOT_DIR}/Frontend"
COMPOSE_FILE="${ROOT_DIR}/compose.yaml"

fail() {
  printf 'DreaMedia: %s\n' "$1" >&2
  exit 1
}

for command_name in docker uv bun; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command '$command_name' was not found. Install it, then rerun ./start.sh."
done

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    fail "Docker is unavailable or this user cannot access it. Start Docker or grant this user Docker access."
  fi
fi

"${DOCKER[@]}" compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (docker compose)."
[[ -f "${COMPOSE_FILE}" ]] || fail "Root Compose file not found: ${COMPOSE_FILE}"

if [[ ! -f "${BACKEND_DIR}/.env" ]]; then
  cp "${BACKEND_DIR}/.env.example" "${BACKEND_DIR}/.env"
  printf 'Created Backend/.env from Backend/.env.example.\n'
fi

compose() {
  "${DOCKER[@]}" compose --project-directory "${ROOT_DIR}" -f "${COMPOSE_FILE}" "$@"
}

printf 'Starting PostgreSQL from root compose.yaml...\n'
compose up -d db

ready=false
for _ in {1..60}; do
  if compose exec -T db pg_isready -U dreamedia -d dreamedia >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "${ready}" != true ]]; then
  compose logs db >&2 || true
  fail "PostgreSQL did not become ready within 60 seconds."
fi

printf 'Syncing locked Python and Node dependencies...\n'
(cd "${BACKEND_DIR}" && uv sync --frozen)
(cd "${FRONTEND_DIR}" && bun install --frozen-lockfile)

printf '\nStarting DreaMedia services.\n'
printf 'Frontend: http://localhost:3000\n'
printf 'Backend:  http://127.0.0.1:8000/health\n'
printf 'Press Ctrl+C to stop FastAPI and Vite. PostgreSQL and its data volume will remain running.\n\n'

(cd "${BACKEND_DIR}" && exec uv run -m App.main) &
BACKEND_PID=$!
(cd "${FRONTEND_DIR}" && exec bun run dev) &
FRONTEND_PID=$!

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  kill "${BACKEND_PID}" "${FRONTEND_PID}" 2>/dev/null || true
  wait "${BACKEND_PID}" 2>/dev/null || true
  wait "${FRONTEND_PID}" 2>/dev/null || true
  exit "${exit_code}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait -n "${BACKEND_PID}" "${FRONTEND_PID}"
