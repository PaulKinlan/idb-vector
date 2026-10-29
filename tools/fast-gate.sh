#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# The unit tier cannot exercise CSS/HTML; publish every changed path as an
# explicit coverage warning before the test runner (even if it later fails).
bash tools/report-fast-style-coverage.sh
# The split is defined once, in tools/unit-tier-suites.sh: fast is the unit glob minus the
# middle list, so a new unit suite is fast by default and an integration-shaped one is
# excluded with one line.
mapfile -t fast_suites < <(bash tools/unit-tier-suites.sh fast)
mapfile -t middle_suites < <(bash tools/unit-tier-suites.sh middle)
# Name the suites being dispatched even when node:test fails (set -e exits on failure).
printf 'fast-gate: running:'
printf ' %s' "${fast_suites[@]}"
printf '\n'
# Never let the excluded suites look covered: the lane runs them before hand-off and the
# merger's full gate runs them on the merged tree.
printf 'fast-gate: not run here (npm run test:middle before hand-off):'
printf ' %s' "${middle_suites[@]}"
printf '\n'
npm run test:fast
