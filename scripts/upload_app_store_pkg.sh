#!/bin/zsh
set -eu

PKG_PATH="${1:-}"
APPLE_ID="${APP_STORE_APPLE_ID:-}"
APP_PASSWORD="${APP_STORE_APP_SPECIFIC_PASSWORD:-}"
ASC_PROVIDER="${APP_STORE_ASC_PROVIDER:-}"

if [[ -z "${PKG_PATH}" || ! -f "${PKG_PATH}" ]]; then
  echo "Usage: APP_STORE_APPLE_ID=... APP_STORE_APP_SPECIFIC_PASSWORD=... $0 path/to/app.pkg" >&2
  exit 1
fi

if [[ -z "${APPLE_ID}" || -z "${APP_PASSWORD}" ]]; then
  cat >&2 <<'MSG'
Set APP_STORE_APPLE_ID and APP_STORE_APP_SPECIFIC_PASSWORD.

Use an app-specific password, not your Apple ID password. If your account requires provider selection,
also set APP_STORE_ASC_PROVIDER.
MSG
  exit 1
fi

if xcrun --find altool >/dev/null 2>&1; then
  args=(altool --upload-app --type macos --file "${PKG_PATH}" --username "${APPLE_ID}" --password "${APP_PASSWORD}")
  if [[ -n "${ASC_PROVIDER}" ]]; then
    args+=(--asc-provider "${ASC_PROVIDER}")
  fi
  xcrun "${args[@]}"
elif [[ -x "/Applications/Transporter.app/Contents/itms/bin/iTMSTransporter" ]]; then
  transporter="/Applications/Transporter.app/Contents/itms/bin/iTMSTransporter"
  args=(-m upload -assetFile "${PKG_PATH}" -u "${APPLE_ID}" -p "${APP_PASSWORD}")
  if [[ -n "${ASC_PROVIDER}" ]]; then
    args+=(-itc_provider "${ASC_PROVIDER}")
  fi
  "${transporter}" "${args[@]}"
else
  cat >&2 <<'MSG'
No upload tool was found.

Install full Xcode or Apple's Transporter app, then either:
- run this script again, or
- open Transporter and drag in the generated .pkg.
MSG
  exit 1
fi
