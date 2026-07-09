#!/bin/zsh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

APP_STORE_BUNDLE_ID="${APP_STORE_BUNDLE_ID:-}"
APP_STORE_APP_NAME="${APP_STORE_APP_NAME:-MedDRA Browser}"
APP_STORE_VERSION="${APP_STORE_VERSION:-$(python3 - "${ROOT_DIR}/frontend/package.json" <<'PY'
import json
import sys
from pathlib import Path

print(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["version"])
PY
)}"
APP_STORE_BUILD_NUMBER="${APP_STORE_BUILD_NUMBER:-$(git -C "${ROOT_DIR}" rev-list --count HEAD 2>/dev/null || echo 1)}"
APP_STORE_APP_IDENTITY="${APP_STORE_APP_IDENTITY:-}"
APP_STORE_INSTALLER_IDENTITY="${APP_STORE_INSTALLER_IDENTITY:-}"
APP_STORE_PROVISIONING_PROFILE="${APP_STORE_PROVISIONING_PROFILE:-}"
ALLOW_BLOCKERS="${ALLOW_KNOWN_APP_STORE_BLOCKERS:-0}"

OUTPUT_DIR="${APP_STORE_OUTPUT_DIR:-${ROOT_DIR}/build/app-store}"
APP_PATH="${OUTPUT_DIR}/${APP_STORE_APP_NAME}.app"
PKG_PATH="${OUTPUT_DIR}/${APP_STORE_APP_NAME}-${APP_STORE_VERSION}-${APP_STORE_BUILD_NUMBER}.pkg"
ENTITLEMENTS="${APP_STORE_ENTITLEMENTS:-${ROOT_DIR}/mac/app-store.entitlements}"

if [[ -z "${APP_STORE_BUNDLE_ID}" || "${APP_STORE_BUNDLE_ID}" == "local.meddra.browser.mac" ]]; then
  echo "Set APP_STORE_BUNDLE_ID to the Bundle ID registered in Apple Developer/App Store Connect." >&2
  exit 1
fi

identity_list="$(security find-identity -v -p codesigning 2>/dev/null || true)"
if [[ -z "${APP_STORE_APP_IDENTITY}" ]]; then
  APP_STORE_APP_IDENTITY="$(grep -E 'Apple Distribution|Mac App Distribution|3rd Party Mac Developer Application' <<<"${identity_list}" | sed -E 's/^ *[0-9]+\\) [A-F0-9]+ \"(.*)\"/\\1/' | head -n 1 || true)"
fi
if [[ -z "${APP_STORE_INSTALLER_IDENTITY}" ]]; then
  APP_STORE_INSTALLER_IDENTITY="$(grep -E 'Mac Installer Distribution|3rd Party Mac Developer Installer' <<<"${identity_list}" | sed -E 's/^ *[0-9]+\\) [A-F0-9]+ \"(.*)\"/\\1/' | head -n 1 || true)"
fi
if [[ -z "${APP_STORE_APP_IDENTITY}" ]]; then
  echo "Missing Mac App Store app signing identity: Apple Distribution / Mac App Distribution / 3rd Party Mac Developer Application." >&2
  exit 1
fi
if [[ -z "${APP_STORE_INSTALLER_IDENTITY}" ]]; then
  echo "Missing Mac App Store installer signing identity: Mac Installer Distribution / 3rd Party Mac Developer Installer." >&2
  exit 1
fi

if [[ "${ALLOW_BLOCKERS}" != "1" ]]; then
  echo "Current architecture is not review-ready. Set ALLOW_KNOWN_APP_STORE_BLOCKERS=1 only for certificate/App Store Connect upload dry-runs." >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"

MEDDRA_APP_NAME="${APP_STORE_APP_NAME}" \
MEDDRA_BUNDLE_ID="${APP_STORE_BUNDLE_ID}" \
MEDDRA_APP_VERSION="${APP_STORE_VERSION}" \
MEDDRA_BUILD_NUMBER="${APP_STORE_BUILD_NUMBER}" \
MEDDRA_APP_STORE_MODE=1 \
  "${ROOT_DIR}/scripts/build_macos_app.sh" "${APP_PATH}"

if [[ -z "${APP_STORE_PROVISIONING_PROFILE}" ]]; then
  echo "Set APP_STORE_PROVISIONING_PROFILE to the Mac App Store provisioning profile downloaded from Apple Developer." >&2
  exit 1
fi
if [[ ! -f "${APP_STORE_PROVISIONING_PROFILE}" ]]; then
  echo "Provisioning profile not found: ${APP_STORE_PROVISIONING_PROFILE}" >&2
  exit 1
fi
cp "${APP_STORE_PROVISIONING_PROFILE}" "${APP_PATH}/Contents/embedded.provisionprofile"

codesign --force --timestamp --options runtime --entitlements "${ENTITLEMENTS}" --sign "${APP_STORE_APP_IDENTITY}" "${APP_PATH}"
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"

"${ROOT_DIR}/scripts/preflight_app_store.sh" "${APP_PATH}"

productbuild --component "${APP_PATH}" /Applications --sign "${APP_STORE_INSTALLER_IDENTITY}" --timestamp "${PKG_PATH}"
pkgutil --check-signature "${PKG_PATH}"

echo "${PKG_PATH}"
