# Gate speed and demo coverage

The implementer fast gate (`fleet-check --fast`) runs `tools/fast-gate.sh` with a 120-second bound. It runs the independent `tests/unit/*.test.mjs` suites without launching Chromium; the merger runs the full gate once on its merged tree. Keep unit tests independent of test order, host state and other worktrees. A new unit file should not add a browser launch to this tier.

**The runner is capped at 2 workers** (`node --test --test-concurrency=2`, ADR idb-vector-518, bead idb-vector-fmm): all unit files still run, but unbounded parallelism put ~24 child processes on the 2-vCPU VM and oversubscription dominated. Measured on the same tree (24 files/122 tests) at load ~8: unbounded 118.8s wall (and two 120s bound-kills at load 8-10), capped 57.4s wall — the loaded run now sits at half the bound. The cap is a contract: `tests/unit/fast-style-coverage.test.mjs` asserts the glob and the bound survive edits.

**CSS and HTML are not exercised by this fast unit tier.** `tools/report-fast-style-coverage.sh` compares the branch tip to its `origin/main` merge-base and emits `fast-gate: unmapped: <path>` for *each* changed `.css` or `.html` file before the suites run. Fleet-check surfaces those markers as a **COVERAGE WARNING**, even though its shared changed-file extractor does not classify these extensions. If the base cannot be determined, the gate explicitly reports `fast-gate: unknown:` rather than claiming coverage. A passing unit gate with these notices is not visual/browser verification.

For demo style or markup changes, drive the affected demo in Chromium, assert the actual interaction or computed styles at relevant viewport sizes and colour schemes, and capture a screenshot. Use a focused browser check during implementation; do not add a full browser run to the fast unit tier. On landing, the merger runs the full gate (`npm test` including `npm run test:demo-restore`, `npm run test:packed`, `npm run test:wikipedia`) once on the merged result. The focused restore test drives Chromium and is deliberately excluded from `test:fast`; its changed file may appear as an unmapped fast-gate coverage warning, but it runs in the full gate. The compute lab is separate; when it changes, drive its controls and inspect the rendered report as well.

`npm run test:compute` is that lab's focused browser check (real click, 100k × 128
synthetic corpus, storage roundtrips, four-path top-k, near-tie fixture, screenshots);
measured **62 s on the 2-vCPU fleet VM**, so it is deliberately in neither the fast unit
tier nor the merger's full gate. It is host-load sensitive — the same check has measured
57–96 s, and its internal 240 s run bound was hit while another lane held the heavy slot —
so run it on a machine that is not saturated. Its pure numeric contract — corpus determinism, cosine
definition, tie ordering, and the comparison instrument's mutant rejection — is covered
by `tests/unit/compute-engines.test.mjs` in the fast tier, which launches no browser.

## Packed-snapshot stress measurement (not in the full gate)

`npm run test:packed` is the merger's packed-snapshot **correctness** leg: contract checks, the 2000x384
committed real corpus, a 1000x128 seeded synthetic corpus, exact byte comparison of cached ranking against
the plain scan, rollback and optional whitening. It must stay inside the full gate's budget.

The 100000x128 measurement used to live in that same file. It is a benchmark, not a gate: it wrote
100,000 vectors in batches of 1000 and timed three comparisons, which pushed the full gate past **900 s at
host load ~10** — 37% of its 2400 s allowance — while the small corpora already cover the exactness claim
(idb-vector-bqw, ADR idb-vector-80j). It now lives in `tests/packed-snapshot-stress.mjs`:

- `npm run measure:packed-snapshot` — opt-in, writes its report and screenshot into a **unique directory
  it prints and keeps** (`PACKED_SNAPSHOT_STRESS_DIR` redirects it, `PACKED_SNAPSHOT_STRESS_COUNT` resizes
  the corpus for a smoke run). It asserts bit-identical keys, scores and order against the plain scan at
  high cardinality, so the size-dependent check still exists and still fails loudly.
- `.github/workflows/packed-stress.yml` owns the schedule: weekly, plus a push touching
  `utils/packed-snapshot.js`, `utils/sortedarray.js`, `index.js`, `tools/demo-server.mjs` or the stress
  test itself. It uploads the evidence directory as an artifact. Owner: the workflow (CI), not a lane —
  no implementer or merger run pays its cost.

Do not move it back into `npm test`, `test:packed` or the fast tier, and do not "fix" a slow full gate by
raising `CHECK_TIMEOUT`. If the correctness leg starts approaching the budget, the answer is a smaller
corpus with a pointer to the stress command, not a longer bound.
