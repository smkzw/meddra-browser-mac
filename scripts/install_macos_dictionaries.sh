#!/bin/zsh
set -eu

DEFAULT_SOURCE="${HOME}/Documents/指导原则及临床试验规范合集/MedDRA"
SOURCE_ROOT="${1:-${MEDDRA_SOURCE_ROOT:-${DEFAULT_SOURCE}}}"
DEST_ROOT="${HOME}/Library/Application Support/MedDRA Browser Mac/dictionaries"

if [ ! -d "${SOURCE_ROOT}" ]; then
  echo "Source directory does not exist: ${SOURCE_ROOT}" >&2
  exit 1
fi

mkdir -p "${DEST_ROOT}"

copied=0
if [ -f "${SOURCE_ROOT}/soc.asc" ]; then
  target="${DEST_ROOT}/$(basename "${SOURCE_ROOT}")"
  rm -rf "${target}"
  ditto "${SOURCE_ROOT}" "${target}"
  copied=$((copied + 1))
else
  for item in "${SOURCE_ROOT}"/*; do
    if [ ! -d "${item}" ]; then
      continue
    fi
    if find "${item}" -name soc.asc -print -quit | grep -q .; then
      target="${DEST_ROOT}/$(basename "${item}")"
      rm -rf "${target}"
      ditto "${item}" "${target}"
      copied=$((copied + 1))
    fi
  done
fi

if [ "${copied}" -eq 0 ]; then
  echo "No MedDRA release directories containing soc.asc were found under: ${SOURCE_ROOT}" >&2
  exit 1
fi

rm -f "${HOME}/Library/Application Support/MedDRA Browser Mac/data/source_roots.json"
echo "Copied ${copied} MedDRA release director$( [ "${copied}" -eq 1 ] && echo y || echo ies ) to:"
echo "${DEST_ROOT}"
