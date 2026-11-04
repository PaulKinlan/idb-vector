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
# Name the suites being dispatched before the runner: when a suite fails this line is the only
# statement of what the lane covered, because the gate exits with the runner's status.
printf 'fast-gate: running:'
printf ' %s' "${fast_suites[@]}"
printf '\n'
# `npm run test:fast` is the only runner for this tier and it preloads tests/support/fast-tier-guard.mjs
# (NODE_OPTIONS=--import), which makes a suite that spawns a process or binds a socket fail in its own
# test instead of quietly stretching the budget. Do not dispatch these suites another way here.
# Never let the excluded suites look covered: the lane runs them before hand-off and the
# merger's full gate runs them on the merged tree.
printf 'fast-gate: not run here (npm run test:middle before hand-off):'
printf ' %s' "${middle_suites[@]}"
printf '\n'
# The dispatch stays exactly this line (tests/unit/fast-tier-guard.test.mjs: it is the only way the
# guarded tier is started); its status is captured rather than exited on so the report below still runs.
set +e
npm run test:fast
rc=$?
set -e
# Last, so it is the tail fleet-check records: a changed middle-tier suite was verified by nothing in
# this lane, and that reader needs the command that does verify it (idb-vector-ap0u). Reporting never
# changes the verdict, so this runs after the runner's status is captured and cannot fail the gate.
bash tools/report-changed-middle-suites.sh ||
  printf 'fast-gate: middle-tier-uncovered: UNKNOWN (tools/report-changed-middle-suites.sh failed)\n'
exit "$rc"
