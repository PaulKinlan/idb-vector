#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# The unit tier cannot exercise CSS/HTML; publish every changed path as an
# explicit coverage warning before the test runner (even if it later fails).
bash tools/report-fast-style-coverage.sh
# Name the suites being dispatched even when node:test fails (set -e exits on failure).
printf 'fast-gate: running:'
printf ' %s' tests/unit/*.test.mjs
printf '\n'
npm run test:fast
