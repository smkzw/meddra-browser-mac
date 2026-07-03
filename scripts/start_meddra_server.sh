#!/bin/zsh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOST="${MEDDRA_BROWSER_HOST:-127.0.0.1}"
PORT="${MEDDRA_BROWSER_PORT:-8765}"
LOG_DIR="${REPO_DIR}/logs/app"
SERVER_LOG="${LOG_DIR}/server.log"
PID_FILE="${LOG_DIR}/server.pid"
VENV_DIR="${REPO_DIR}/.venv_macos"

mkdir -p "${LOG_DIR}"
cd "${REPO_DIR}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "未找到 python3。请先安装 Python 3.9 或更新版本，然后重新运行第一步入口。" >&2
  exit 1
fi

if [ ! -x "${VENV_DIR}/bin/python" ]; then
  echo "正在准备本地 Python 运行环境..."
  python3 -m venv "${VENV_DIR}"
fi

echo "正在检查后端依赖..."
if ! "${VENV_DIR}/bin/python" -m pip install -r "${REPO_DIR}/backend/requirements.txt" >> "${SERVER_LOG}" 2>&1; then
  echo "后端依赖安装失败。最近日志如下：" >&2
  tail -n 40 "${SERVER_LOG}" >&2 || true
  exit 1
fi

export PYTHONPATH="${REPO_DIR}/backend"
echo "$$" > "${PID_FILE}"
exec "${VENV_DIR}/bin/python" "${REPO_DIR}/scripts/run_portable_server.py"
