#!/usr/bin/env bash
# The unit tier split, in ONE place (docs/speed.md, idb-vector-t7u).
#
#   bash tools/unit-tier-suites.sh fast     every tests/unit/*.test.mjs suite MINUS middle
#   bash tools/unit-tier-suites.sh middle   the suites listed below, in this order
#
# The fast tier is the per-lane contract: it must contain only suites that never spawn a
# child process, never bind a socket and never clone or stage the repo, so a loaded host
# cannot stretch it past its budget. Everything integration-shaped or measurement-heavy
# runs in the middle tier instead: `npm run test:middle` on the branch before hand-off,
# and `npm test` (the merger's full gate) runs it too.
#
# A new unit file is fast by default; that is why the middle tier is an enumerated list
# and not a glob. Adding an integration-shaped suite means adding one line to `middle`.
set -euo pipefail
cd "$(dirname "$0")/.."

middle=(
  tests/unit/packed-stress-split.test.mjs      # execFileSync: clones the repo, runs a stress driver
  tests/unit/site-staging.test.mjs             # execFileSync: tools/stage-site.mjs
  tests/unit/demo-server-routing.test.mjs      # binds loopback and fetches from it
  tests/unit/demo-server.test.mjs              # binds loopback, raw sockets
  tests/unit/start-command.test.mjs            # http.createServer + loopback fetch: binds a socket
  tests/unit/real-vector-pins.test.mjs         # reads pinned corpora and reports from disk
  tests/unit/integrity.test.mjs                # reads the shipped demo manifest and assets
  tests/unit/packed-snapshot-validation.test.mjs  # full snapshot build per case
  tests/unit/quantized-pass.test.mjs           # quantized experiment sweeps
)

case "${1:-}" in
  middle)
    for suite in "${middle[@]}"; do
      [[ -f $suite ]] || { echo "unit-tier-suites: missing suite $suite" >&2; exit 1; }
    done
    printf '%s\n' "${middle[@]}"
    ;;
  fast)
    LC_ALL=C comm -23 \
      <(printf '%s\n' tests/unit/*.test.mjs | LC_ALL=C sort) \
      <(printf '%s\n' "${middle[@]}" | LC_ALL=C sort)
    ;;
  *)
    echo "usage: $0 fast|middle" >&2
    exit 2
    ;;
esac
