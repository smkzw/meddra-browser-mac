#!/bin/zsh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOST="${MEDDRA_BROWSER_HOST:-127.0.0.1}"
PORT="${MEDDRA_BROWSER_PORT:-8765}"
LOG_DIR="${REPO_DIR}/logs/app"
SERVER_LOG="${LOG_DIR}/server.log"
PID_FILE="${LOG_DIR}/server.pid"

mkdir -p "${LOG_DIR}"
cd "${REPO_DIR}"

if [ -z "${MEDDRA_SOURCE_ROOT:-}" ] && [ -d "${REPO_DIR}/dictionaries" ]; then
  export MEDDRA_SOURCE_ROOT="${REPO_DIR}/dictionaries"
fi

if [ ! -f "${REPO_DIR}/frontend/dist/index.html" ]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "${REPO_DIR}/frontend" && npm run build) >> "${SERVER_LOG}" 2>&1
  fi
fi

if curl -fsS "http://${HOST}:${PORT}/api/status" >/dev/null 2>&1; then
  exit 0
fi

export PYTHONPATH="${REPO_DIR}/backend"
nohup python3 -m uvicorn app.main:app --host "${HOST}" --port "${PORT}" >> "${SERVER_LOG}" 2>&1 &
echo "$!" > "${PID_FILE}"
