#!/bin/zsh
set -eu

SOURCE="${1:-${MEDDRA_SOURCE_ROOT:-$HOME/Documents/MedDRA}}"
DEST="$HOME/Library/Application Support/MedDRA Browser Mac/dictionaries"
if [[ ! -d "$SOURCE" ]]; then
  echo "Source directory does not exist: $SOURCE" >&2
  exit 1
fi

mkdir -p "$DEST"
STAGING="$(mktemp -d "$DEST/.meddra-import.XXXXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

import_dictionary() {
  local path="$1"
  local target="$DEST/$(basename "$path")"
  if [[ -e "$target" || -L "$target" ]]; then
    echo "Already present: $target"
    return
  fi
  ditto "$path" "$STAGING/$(basename "$path")"
  mv -n "$STAGING/$(basename "$path")" "$target"
  echo "Copied: $target"
}

found=0
if [[ -f "$SOURCE/soc.asc" ]]; then
  import_dictionary "$SOURCE"
  found=1
else
  for item in "$SOURCE"/*(/N); do
    if [[ -n "$(find "$item" -name soc.asc -print -quit)" ]]; then
      import_dictionary "$item"
      found=1
    fi
  done
fi
if [[ "$found" != 1 ]]; then
  echo "No MedDRA release directories containing soc.asc were found under: $SOURCE" >&2
  exit 1
fi
