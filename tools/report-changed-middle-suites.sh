#!/usr/bin/env bash
# A changed middle-tier suite is verified by NOTHING in the fast lane (idb-vector-ap0u).
#
# tests/coverage-contract.json maps PRODUCT paths to the suites that assert them, and fleet-check's
# extractor consults that contract only for non-test paths: a changed file that is itself a suite is
# either executed (covered) or reported unmapped with no next step. The middle tier is never executed
# here by design (docs/speed.md: no spawn, no socket, no clone/stage on the per-lane tier), so a lane
# that changes tests/unit/demo-server-routing.test.mjs lands with nothing in the fast gate asserting it.
# That is exactly how it went twice: 0bd3829 and 0612767 both warned "1 unmapped changed file(s)" and
# named no action. This is the missing action, and it is derived from the one tier definition
# (tools/unit-tier-suites.sh) rather than from a list kept here by hand, so it cannot go stale as
# suites are added or re-tiered.
#
# The changed set comes from the CURRENT repo (like tools/report-fast-style-coverage.sh, so a throwaway
# repo can be driven through it); the tier list comes from this script's own checkout, which in the gate
# is the same repository. The marker is deliberately not one fleet-check reads as executed, unmapped or
# unknown: it must inform the reader without moving the verdict.
set -euo pipefail

tip=${2:-HEAD}
base=${1:-}
if [ -z "$base" ]; then
  for ref in origin/main main; do
    if base=$(git merge-base "$ref" "$tip" 2>/dev/null); then break; fi
    base=
  done
fi
# An undeterminable base says nothing here rather than a `fast-gate: unknown:` marker, which would
# demote every run of this lane to UNKNOWN (the style reporter makes the opposite trade: a CSS change
# would otherwise be silently skipped, so silence is worse there and this marker is worse here).
[ -n "$base" ] || exit 0
if ! changed=$(git diff --name-only "$base" "$tip"); then
  exit 0
fi

tier_tool="$(dirname "$0")/unit-tier-suites.sh"
while IFS= read -r suite; do
  [ -n "$suite" ] || continue
  [ -f "$suite" ] || continue # deleted by this change: there is no command to give
  grep -Fxq -- "$suite" <<< "$changed" || continue
  printf 'fast-gate: middle-tier-uncovered: %s (changed here, and the fast gate never runs the middle tier); run it before hand-off: node --test %s\n' \
    "$suite" "$suite"
done < <(bash "$tier_tool" middle)
