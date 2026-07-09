#!/bin/zsh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_PATH="${1:-${ROOT_DIR}/build/MedDRA Browser Mac.app}"
EXPECTED_BUNDLE_ID="${APP_STORE_BUNDLE_ID:-}"
ALLOW_BLOCKERS="${ALLOW_KNOWN_APP_STORE_BLOCKERS:-0}"

failures=()
warnings=()

add_failure() {
  failures+=("$1")
}

add_warning() {
  warnings+=("$1")
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

echo "== MedDRA Browser Mac App Store preflight =="

if ! command_exists xcodebuild; then
  add_failure "未找到 xcodebuild。请安装完整 Xcode。"
else
  developer_dir="$(xcode-select -p 2>/dev/null || true)"
  echo "Developer dir: ${developer_dir}"
  if [[ "${developer_dir}" == *CommandLineTools* ]]; then
    add_failure "当前只有 Xcode Command Line Tools，不是完整 Xcode。请安装 Xcode 并运行 sudo xcode-select -s /Applications/Xcode.app/Contents/Developer。"
  else
    xcodebuild -version || add_failure "xcodebuild 无法运行。"
  fi
fi

if ! command_exists productbuild; then
  add_failure "未找到 productbuild。"
fi

app_identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
if ! grep -Eq "Apple Distribution|Mac App Distribution|3rd Party Mac Developer Application" <<<"${app_identities}"; then
  add_failure "未找到 Mac App Store App 签名证书（Apple Distribution / Mac App Distribution / 3rd Party Mac Developer Application）。"
fi
if ! grep -Eq "Mac Installer Distribution|3rd Party Mac Developer Installer" <<<"${app_identities}"; then
  add_failure "未找到 Mac App Store Installer 签名证书（Mac Installer Distribution / 3rd Party Mac Developer Installer）。"
fi

if [[ -z "${EXPECTED_BUNDLE_ID}" ]]; then
  add_warning "未设置 APP_STORE_BUNDLE_ID；正式上架需使用 App Store Connect 中注册的 Bundle ID。"
elif [[ "${EXPECTED_BUNDLE_ID}" == "local.meddra.browser.mac" ]]; then
  add_failure "APP_STORE_BUNDLE_ID 不能使用默认本地 ID local.meddra.browser.mac。"
fi

if [[ -d "${APP_PATH}" ]]; then
  actual_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${APP_PATH}/Contents/Info.plist" 2>/dev/null || true)"
  actual_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP_PATH}/Contents/Info.plist" 2>/dev/null || true)"
  actual_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${APP_PATH}/Contents/Info.plist" 2>/dev/null || true)"
  echo "App: ${APP_PATH}"
  echo "Bundle ID: ${actual_bundle_id}"
  echo "Version: ${actual_version} (${actual_build})"
  if [[ -n "${EXPECTED_BUNDLE_ID}" && "${actual_bundle_id}" != "${EXPECTED_BUNDLE_ID}" ]]; then
    add_failure "App Bundle ID (${actual_bundle_id}) 与 APP_STORE_BUNDLE_ID (${EXPECTED_BUNDLE_ID}) 不一致。"
  fi

  forbidden="$(find "${APP_PATH}" \( -name '*.asc' -o -name '*.sqlite' -o -name '*.sqlite-shm' -o -name '*.sqlite-wal' -o -name '*.pyc' -o -name '__pycache__' -o -name 'node_modules' -o -name '.git' -o -name '.env' -o -name 'direct_url.json' \) -print)"
  if [[ -n "${forbidden}" ]]; then
    add_failure "App 包含不应上架的词典/缓存/编译/工程文件：${forbidden}"
  fi

  local_hits="$(grep -RIl "${HOME}\\|\\\\Users\\\\$(id -un)" "${APP_PATH}" 2>/dev/null || true)"
  if [[ -n "${local_hits}" ]]; then
    add_failure "App 包含当前构建用户路径：${local_hits}"
  fi
else
  add_warning "尚未构建 App：${APP_PATH}"
fi

if grep -RIn 'osascript\\|System Events\\|open -na \"Microsoft Edge\"\\|open -na \"Google Chrome\"\\|command -v python3\\|uvicorn app.main:app' "${ROOT_DIR}/scripts/build_macos_app.sh" "${ROOT_DIR}/backend/app/main.py" >/tmp/meddra_app_store_arch_hits.txt 2>/dev/null; then
  add_warning "当前 Mac App 仍是脚本壳/本地服务架构。正式审核前建议改为原生 WebView + 原生文件夹选择器 + 安全作用域书签。详见 docs/app-store/APP_STORE_SUBMISSION_ZH.md。"
fi

if [[ "${ALLOW_BLOCKERS}" != "1" ]]; then
  add_failure "当前仓库仍存在 App Store 审核阻断项。若只是生成候选包用于账号/证书联调，请设置 ALLOW_KNOWN_APP_STORE_BLOCKERS=1。"
fi

echo
if (( ${#warnings[@]} > 0 )); then
  echo "Warnings:"
  for item in "${warnings[@]}"; do
    echo "- ${item}"
  done
fi

if (( ${#failures[@]} > 0 )); then
  echo
  echo "Failures:"
  for item in "${failures[@]}"; do
    echo "- ${item}"
  done
  exit 1
fi

echo "Preflight passed."
