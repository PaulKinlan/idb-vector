# Gate speed and demo coverage

There are three tiers. A suite belongs in the fastest tier whose costs it can honour.

| tier | command | runs | budget |
| --- | --- | --- | --- |
| fast | `tools/fast-gate.sh` via `fleet-check --fast` | `tests/unit/*.test.mjs` minus the middle list | **<= 120 s at load 5** |
| middle | `npm run test:middle` | the suites enumerated in `tools/unit-tier-suites.sh` | **<= 180 s** |
| full | `npm test && npm run test:packed && npm run test:wikipedia` (merger) | everything, including both unit tiers | 2400 s (`CHECK_TIMEOUT`) |

**Shape rule for the fast tier.** It contains only suites that never spawn a child process, never bind a socket, and never clone or stage the repo: those three costs track host load, so a tier holding them oscillates between 55 s and 273 s on the same commit, and each bound raise is absorbed within days (idb-vector-t7u). Everything else goes to the middle tier - it still runs, it just stops being the per-lane contract. A new unit file is fast by default; excluding one is a single line in `tools/unit-tier-suites.sh`, which is the only place the split is defined. Known exception: `fast-style-coverage.test.mjs` spawns `git` in a throwaway repo and stays fast, because it was measured at ~2.5 s.

Measured 2026-10-29 on this tree (load 1.1-1.9): fast 32 files/137 tests in 23.8 s, middle 8 files/58 tests in 19.3 s — the whole unit set, now split across two runs.

**The middle tier runs per branch before hand-off** (`npm run test:middle`), so a branch-level failure - staging, server routing, pinned assets, a full snapshot build, a quantized sweep - is caught on the branch and not first at merge. `npm test` ends with `npm run test:middle` on purpose: the merger's `CHECK_CMD` is `npm test && npm run test:packed && npm run test:wikipedia`, and `npm test` runs `tests/*.mjs` only, so naming the middle tier there is what keeps the moved suites in the merged gate. `tools/fast-gate.sh` prints the middle suites it did not run rather than leaving them looking covered.

The fast gate runs without launching Chromium. Keep unit tests independent of test order, host state and other worktrees. A new unit file should not add a browser launch to this tier.

**Both runners are capped at 2 workers** (`node --test --test-concurrency=2`, ADR idb-vector-518, bead idb-vector-fmm): unbounded parallelism put ~24 child processes on the 2-vCPU VM and oversubscription dominated. Measured on the same tree (24 files/122 tests) at load ~8: unbounded 118.8s wall (and two 120s bound-kills at load 8-10), capped 57.4s wall. The cap is a contract: `tests/unit/fast-style-coverage.test.mjs` asserts the concurrency bound and that the two tiers partition the unit glob, so no suite can be dropped from both.

**CSS and HTML are not exercised by this fast unit tier.** `tools/report-fast-style-coverage.sh` compares the branch tip to its `origin/main` merge-base and emits `fast-gate: unmapped: <path>` for *each* changed `.css` or `.html` file before the suites run. Fleet-check surfaces those markers as a **COVERAGE WARNING**, even though its shared changed-file extractor does not classify these extensions. If the base cannot be determined, the gate explicitly reports `fast-gate: unknown:` rather than claiming coverage. A passing unit gate with these notices is not visual/browser verification.

For demo style or markup changes, drive the affected demo in Chromium, assert the actual interaction or computed styles at relevant viewport sizes and colour schemes, and capture a screenshot. Use a focused browser check during implementation; do not add a full browser run to the fast unit tier. On landing, the merger runs the full gate (`npm test` including `npm run test:demo-restore` and the middle unit tier, `npm run test:packed`, `npm run test:wikipedia`) once on the merged result. The focused restore test drives Chromium and is deliberately excluded from `test:fast`; its changed file may appear as an unmapped fast-gate coverage warning, but it runs in the full gate. The compute lab is separate; when it changes, drive its controls and inspect the rendered report as well.

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
