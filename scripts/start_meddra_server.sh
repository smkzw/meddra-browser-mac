#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -d tools ]]; then
  # A translated terminal reports x86_64 even on Apple silicon.
  runtime_arch="$(/usr/bin/uname -m)"
  if [[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ||
        "$(/usr/sbin/sysctl -n sysctl.proc_translated 2>/dev/null || true)" == 1 ]]; then
    runtime_arch=arm64
  fi
  case "$runtime_arch" in
    arm64|x86_64) runtime="tools/python/macos-$runtime_arch/bin/python3.13" ;;
    *) echo "当前 Mac 处理器架构不受支持。" >&2; exit 1 ;;
  esac
  if [[ ! -x "$runtime" ]]; then
    echo "包内 Mac 运行时缺失。请完整解压便携 ZIP 后，再运行 Mac 启动文件。" >&2
    exit 1
  fi
  exec "./$runtime" -I -B -X utf8 scripts/run_portable_server.py
fi

# Source checkout only. The published package always uses its bundled runtime.
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install -r backend/requirements.txt
fi
exec .venv/bin/python -I -B -X utf8 scripts/run_portable_server.py --dev
