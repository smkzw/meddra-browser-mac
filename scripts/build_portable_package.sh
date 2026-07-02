#!/bin/zsh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_ROOT="${ROOT_DIR}/build/portable/meddra-browser-portable"
ZIP_PATH="${ROOT_DIR}/build/meddra-browser-portable.zip"

cd "${ROOT_DIR}"

(cd frontend && npm run build)

rm -rf "${PACKAGE_ROOT}" "${ZIP_PATH}"
mkdir -p "${PACKAGE_ROOT}/backend" "${PACKAGE_ROOT}/frontend" "${PACKAGE_ROOT}/scripts" "${PACKAGE_ROOT}/dictionaries"

cp -R backend/app "${PACKAGE_ROOT}/backend/app"
find "${PACKAGE_ROOT}/backend/app" -name "__pycache__" -type d -prune -exec rm -rf {} +
cp backend/requirements.txt "${PACKAGE_ROOT}/backend/requirements.txt"
cp -R frontend/dist "${PACKAGE_ROOT}/frontend/dist"
cp scripts/start_meddra_server.sh "${PACKAGE_ROOT}/scripts/start_meddra_server.sh"
cp start_windows.bat "${PACKAGE_ROOT}/start_windows.bat"
cp portable-index.html "${PACKAGE_ROOT}/index.html"
cp README.md "${PACKAGE_ROOT}/README.md"
cp LICENSE.md "${PACKAGE_ROOT}/LICENSE.md"

cat > "${PACKAGE_ROOT}/dictionaries/README.txt" <<'TXT'
Place your licensed MedDRA ASCII dictionary folders here, or set MEDDRA_SOURCE_ROOT to another folder before starting the browser.

Expected files inside a release folder include soc.asc, hlgt.asc, hlt.asc, pt.asc, llt.asc, mdhier.asc, hlt_pt.asc, hlgt_hlt.asc, soc_hlgt.asc, smq_list.asc, and smq_content.asc.

MedDRA data is licensed separately and is not included in this package.
TXT

chmod +x "${PACKAGE_ROOT}/scripts/start_meddra_server.sh"

mkdir -p "$(dirname "${ZIP_PATH}")"
(cd "${ROOT_DIR}/build/portable" && zip -qr "${ZIP_PATH}" meddra-browser-portable)

echo "${ZIP_PATH}"
