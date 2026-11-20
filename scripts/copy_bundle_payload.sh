#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEST="$1"
mkdir -p "$DEST/backend" "$DEST/frontend" "$DEST/scripts" "$DEST/notices"
cp -R backend/app "$DEST/backend/"
cp -R frontend/dist "$DEST/frontend/"
cp scripts/run_portable_server.py "$DEST/scripts/"
cp LICENSE.md "$DEST/"
find "$DEST/backend" -type d -name __pycache__ -prune -exec rm -rf {} +

for library in react react-dom scheduler lucide-react; do
  cp "frontend/node_modules/$library/LICENSE" "$DEST/notices/$library.txt"
done
cp frontend/node_modules/vite/LICENSE.md "$DEST/notices/vite.md"
