#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run test:fast
# Report the same glob npm's node:test command ran, after it succeeds.
printf 'fast-gate: passed:'
printf ' %s' tests/unit/*.test.mjs
printf '\n'
