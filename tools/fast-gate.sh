#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Name the suites being dispatched even when node:test fails (set -e exits on failure).
printf 'fast-gate: running:'
printf ' %s' tests/unit/*.test.mjs
printf '\n'
npm run test:fast
