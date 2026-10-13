#!/usr/bin/env bash
# CSS/HTML are intentionally outside the fast unit tier. Report them to
# fleet-check's coverage extractor rather than letting it silently skip them.
set -euo pipefail

tip=${2:-HEAD}
base=${1:-}
if [ -z "$base" ]; then
  for ref in origin/main main; do
    if base=$(git merge-base "$ref" "$tip" 2>/dev/null); then break; fi
    base=
  done
fi
if [ -z "$base" ]; then
  echo 'fast-gate: unknown: no base branch for CSS/HTML coverage; a browser probe is required for style/markup changes'
  exit 0
fi
if ! changed=$(git diff --name-only "$base" "$tip"); then
  echo 'fast-gate: unknown: cannot inspect CSS/HTML changes; a browser probe is required'
  exit 0
fi
while IFS= read -r path; do
  case "$path" in
    *.css|*.html)
      printf 'fast-gate: unmapped: %s\n' "$path"
      ;;
  esac
done <<< "$changed"
