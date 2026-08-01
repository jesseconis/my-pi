#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source_dir="$repo_root/agent"
target_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
timestamp=$(date +%Y%m%d-%H%M%S)

mkdir -p -- "$target_dir"
shopt -s nullglob

for source in "$source_dir"/*.json; do
  name=$(basename -- "$source")
  target="$target_dir/$name"

  if [[ -L "$target" ]] && [[ "$(readlink -f -- "$target")" == "$(readlink -f -- "$source")" ]]; then
    printf 'already linked: %s\n' "$target"
    continue
  fi

  if [[ -e "$target" || -L "$target" ]]; then
    backup="$target.backup-$timestamp"
    mv -- "$target" "$backup"
    printf 'backed up: %s -> %s\n' "$target" "$backup"
  fi

  relative_source=$(realpath --relative-to="$target_dir" -- "$source")
  ln -s -- "$relative_source" "$target"
  printf 'linked: %s -> %s\n' "$target" "$relative_source"
done
