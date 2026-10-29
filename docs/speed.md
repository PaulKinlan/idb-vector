# Gate speed and demo coverage

There are three tiers. A suite belongs in the fastest tier whose costs it can honour.

| tier | command | runs | budget |
| --- | --- | --- | --- |
| fast | `tools/fast-gate.sh` via `fleet-check --fast` | `tests/unit/*.test.mjs` minus the middle list | **<= 120 s at load 5** |
| middle | `npm run test:middle` | the suites enumerated in `tools/unit-tier-suites.sh` | **<= 180 s** |
| full | `npm test && npm run test:packed && npm run test:wikipedia` (merger) | `npm test` - the `tests/*.mjs` drivers plus, because the `test` script ends with `npm run test:middle`, the middle unit tier - then the packed and wikipedia legs | 2400 s (`CHECK_TIMEOUT`) |

**Shape rule for the fast tier (policy, enforced at runtime).** It contains only suites that never spawn a child process, never bind a socket, and never clone or stage the repo: those three costs track host load, so a tier holding them oscillates between 55 s and 273 s on the same commit, and each bound raise is absorbed within days (idb-vector-t7u). Everything else goes to the middle tier - it still runs, it just stops being the per-lane contract. A new unit file is fast by default; excluding one is a single line in `tools/unit-tier-suites.sh`, which is the only place the split is defined. A suite that breaks this rule fails in its own test at runtime (below); the one fast suite that does spawn is a written, documented exception, recorded as an opt-out in the guard.

Measured 2026-10-29 on this tree (load 1.1-1.9), before the guard moved `start-command.test.mjs` out of the fast tier: fast 32 files/137 tests in 23.8 s, middle 8 files/58 tests in 19.3 s — the whole unit set, split across two runs. Today the fast tier is 32 files/141 tests (the guard's own suite is +6, `start-command.test.mjs`'s 2 moved to middle, which is now 9 files).

**The rule is enforced at runtime, by one guard loaded only for the fast tier** (idb-vector-kljx). `tests/support/fast-tier-guard.mjs` replaces `child_process.{execSync,execFileSync,spawn,spawnSync,exec,execFile,fork}`, `net.createServer`, `net.Server.prototype.listen`, `http.createServer` and `https.createServer` with throwing stubs whose message names the construct and points at the `middle` list in `tools/unit-tier-suites.sh`. It is preloaded by `NODE_OPTIONS=--import ./tests/support/fast-tier-guard.mjs` on `npm run test:fast`, the command `tools/fast-gate.sh` dispatches, so running the fast script cannot skip it; `npm run test:middle` and `npm test` do not load it, because their suites spawn processes and bind loopback sockets deliberately. A fast suite that spawns or listens therefore fails in its own test, which is exact: nothing to evade with a string, a comment or a computed import, and no source parsing. Exemptions are explicit, reasoned opt-outs in that one file - today exactly one, `fast-style-coverage.test.mjs`. `tests/unit/fast-tier-guard.test.mjs` proves every patched entry point throws and that only the fast tier command preloads the guard. Static source analysis was tried for four rounds on idb-vector-t7u and abandoned - a call-name scan (round 1), a hand-rolled comment/string lexer (round 2), and a module-specifier allowlist (round 3) were each evaded by valid JavaScript: a string holding `//` blanked the rest of the line for the lexer, and a same-line `import` plus a computed `import(expr)` slipped past the allowlist. There is no parser dependency on this VM, so that is a parser problem we are not buying with review cycles; the guard needs none.

**What that guard covers, and what it deliberately does not** (idb-vector-kljx). In scope: exactly `child_process.{execSync,execFileSync,spawn,spawnSync,exec,execFile,fork}`, `net.createServer`, `net.Server.prototype.listen`, `http.createServer` and `https.createServer`, reached by property access, by named or default ESM import, or through a dynamic `await import()`, plus the three raw shortcuts `process.binding('spawn_sync')`, `process.binding('tcp_wrap')` and `process.binding('pipe_wrap')`. Out of scope by design: `process.binding` of any other native binding, `process.mainModule`, native addons, and a second Node process. This is a guardrail against accidental shape drift - an author reaching for `execSync` is told to use the middle tier - not a sandbox: defeating it deliberately through Node's native internals would need OS-level confinement (namespaces, no-net) that this fleet does not have, and the same boundary is recorded for idb-vector-bmq.

**What is asserted here is the partition**, which is exact and cheap: `tests/unit/fast-style-coverage.test.mjs` takes both lists from `tools/unit-tier-suites.sh` (the single definition) and pins that fast + middle == `tests/unit/*.test.mjs` with no overlap and no omission, that the middle list is enumerated rather than a glob, that both runners keep `--test-concurrency=2`, and that `npm test` ends with `npm run test:middle`, so the merged gate cannot silently lose the middle suites. Known exception to the shape policy: `fast-style-coverage.test.mjs` itself spawns `git` in a throwaway repo (measured ~2.5 s), so the guard carries an explicit, reasoned opt-out for it.

**What runs where.** The fast tier is the per-lane gate only: `tools/fast-gate.sh` (via `fleet-check --fast`) dispatches `npm run test:fast` from that same tier list. The middle tier runs twice. Once per branch before hand-off (`npm run test:middle`), so a branch-level failure - staging, server routing, pinned assets, a full snapshot build, a quantized sweep - is caught on the branch and not first at merge. And once inside `npm test` for the merged gate: the merger's `CHECK_CMD` is `npm test && npm run test:packed && npm run test:wikipedia`, `npm test` runs `tests/*.mjs` only, so the `test` script ends with `npm run test:middle` - appending it there, not a glob change, is what keeps the moved suites in the merged gate. The merged gate does not re-run the fast tier; the lane already paid it. `tools/fast-gate.sh` prints the middle suites it did not run rather than leaving them looking covered.

The fast gate runs without launching Chromium. Keep unit tests independent of test order, host state and other worktrees. A new unit file should not add a browser launch to this tier.

**Both runners are capped at 2 workers** (`node --test --test-concurrency=2`, ADR idb-vector-518, bead idb-vector-fmm): unbounded parallelism put ~24 child processes on the 2-vCPU VM and oversubscription dominated. Measured on the same tree (24 files/122 tests) at load ~8: unbounded 118.8s wall (and two 120s bound-kills at load 8-10), capped 57.4s wall. The cap is a contract: `tests/unit/fast-style-coverage.test.mjs` asserts the concurrency bound and that the two tiers partition the unit glob, so no suite can be dropped from both. The rule that no spawn/socket/clone cost creeps back into the per-lane tier is enforced at runtime by `tests/support/fast-tier-guard.mjs`, so a violation fails the offending suite rather than only review.

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
