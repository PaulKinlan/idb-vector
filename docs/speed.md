# Gate speed and demo coverage

There are three tiers. A suite belongs in the fastest tier whose costs it can honour.

| tier | command | runs | budget |
| --- | --- | --- | --- |
| fast | `tools/fast-gate.sh` via `fleet-check --fast` | `tests/unit/*.test.mjs` minus the middle list | **<= 120 s at load 5** |
| middle | `npm run test:middle` | the suites enumerated in `tools/unit-tier-suites.sh` | **<= 180 s** |
| full | `npm test && npm run test:packed && npm run test:wikipedia && npm run gate:research` (merger) | `npm test` - the `tests/*.mjs` drivers plus, because the `test` script ends with `npm run test:middle`, the middle unit tier - then the packed and wikipedia legs, then the research publication leg under its own 300 s bound | **3600 s** bound (`CHECK_TIMEOUT`, raised from 2400 s after this measurement) against **2236 s measured** on 2026-10-31 - see [Merged gate time](#merged-gate-time-four-legs-2236-s-measured-idb-vector-9dze) |

**Shape rule for the fast tier (policy, enforced at runtime).** It contains only suites that never spawn a child process, never bind a socket, and never clone or stage the repo: those three costs track host load, so a tier holding them oscillates between 55 s and 273 s on the same commit, and each bound raise is absorbed within days (idb-vector-t7u). Everything else goes to the middle tier - it still runs, it just stops being the per-lane contract. A new unit file is fast by default; excluding one is a single line in `tools/unit-tier-suites.sh`, which is the only place the split is defined. A suite that breaks this rule fails in its own test at runtime (below); the one fast suite that does spawn is a written, documented exception, recorded as an opt-out in the guard.

Measured 2026-10-29 on this tree (load 1.1-1.9), before the guard moved `start-command.test.mjs` out of the fast tier: fast 32 files/137 tests in 23.8 s, middle 8 files/58 tests in 19.3 s — the whole unit set, split across two runs. Today the fast tier is 32 files/141 tests (the guard's own suite is +6, `start-command.test.mjs`'s 2 moved to middle, which is now 9 files).

**The rule is enforced at runtime, by one guard loaded only for the fast tier** (idb-vector-kljx). `tests/support/fast-tier-guard.mjs` replaces `child_process.{execSync,execFileSync,spawn,spawnSync,exec,execFile,fork}`, `net.createServer`, `net.Server.prototype.listen`, `http.createServer` and `https.createServer` with throwing stubs whose message names the construct and points at the `middle` list in `tools/unit-tier-suites.sh`. It is preloaded by `NODE_OPTIONS=--import ./tests/support/fast-tier-guard.mjs` on `npm run test:fast`, the command `tools/fast-gate.sh` dispatches, so running the fast script cannot skip it; `npm run test:middle` and `npm test` do not load it, because their suites spawn processes and bind loopback sockets deliberately. A fast suite that spawns or listens therefore fails in its own test, which is exact: nothing to evade with a string, a comment or a computed import, and no source parsing. Exemptions are explicit, reasoned opt-outs in that one file - today exactly one, `fast-style-coverage.test.mjs`. `tests/unit/fast-tier-guard.test.mjs` proves every patched entry point throws and that only the fast tier command preloads the guard. Static source analysis was tried for four rounds on idb-vector-t7u and abandoned - a call-name scan (round 1), a hand-rolled comment/string lexer (round 2), and a module-specifier allowlist (round 3) were each evaded by valid JavaScript: a string holding `//` blanked the rest of the line for the lexer, and a same-line `import` plus a computed `import(expr)` slipped past the allowlist. There is no parser dependency on this VM, so that is a parser problem we are not buying with review cycles; the guard needs none.

**What that guard covers, and what it deliberately does not** (idb-vector-kljx). In scope: exactly `child_process.{execSync,execFileSync,spawn,spawnSync,exec,execFile,fork}`, `net.createServer`, `net.Server.prototype.listen`, `http.createServer` and `https.createServer`, reached by property access, by named or default ESM import, or through a dynamic `await import()`, plus the three raw shortcuts `process.binding('spawn_sync')`, `process.binding('tcp_wrap')` and `process.binding('pipe_wrap')`. Out of scope by design: `process.binding` of any other native binding, `process.mainModule`, native addons, and a second Node process. This is a guardrail against accidental shape drift - an author reaching for `execSync` is told to use the middle tier - not a sandbox: defeating it deliberately through Node's native internals would need OS-level confinement (namespaces, no-net) that this fleet does not have, and the same boundary is recorded for idb-vector-bmq.

**What is asserted here is the partition**, which is exact and cheap: `tests/unit/fast-style-coverage.test.mjs` takes both lists from `tools/unit-tier-suites.sh` (the single definition) and pins that fast + middle == `tests/unit/*.test.mjs` with no overlap and no omission, that the middle list is enumerated rather than a glob, that both runners keep `--test-concurrency=2`, and that `npm test` ends with `npm run test:middle`, so the merged gate cannot silently lose the middle suites. Known exception to the shape policy: `fast-style-coverage.test.mjs` itself spawns `git` in a throwaway repo (measured ~2.5 s), so the guard carries an explicit, reasoned opt-out for it.

**What runs where.** The fast tier is the per-lane gate only: `tools/fast-gate.sh` (via `fleet-check --fast`) dispatches `npm run test:fast` from that same tier list. The middle tier runs twice. Once per branch before hand-off (`npm run test:middle`), so a branch-level failure - staging, server routing, pinned assets, a full snapshot build, a quantized sweep - is caught on the branch and not first at merge. And once inside `npm test` for the merged gate: the merger's `CHECK_CMD` is `npm test && npm run test:packed && npm run test:wikipedia && npm run gate:research`, `npm test` runs `tests/*.mjs` only, so the `test` script ends with `npm run test:middle` - appending it there, not a glob change, is what keeps the moved suites in the merged gate. The merged gate does not re-run the fast tier; the lane already paid it. `tools/fast-gate.sh` prints the middle suites it did not run rather than leaving them looking covered.

The fast gate runs without launching Chromium. Keep unit tests independent of test order, host state and other worktrees. A new unit file should not add a browser launch to this tier.

**Both runners are capped at 2 workers** (`node --test --test-concurrency=2`, ADR idb-vector-518, bead idb-vector-fmm): unbounded parallelism put ~24 child processes on the 2-vCPU VM and oversubscription dominated. Measured on the same tree (24 files/122 tests) at load ~8: unbounded 118.8s wall (and two 120s bound-kills at load 8-10), capped 57.4s wall. The cap is a contract: `tests/unit/fast-style-coverage.test.mjs` asserts the concurrency bound and that the two tiers partition the unit glob, so no suite can be dropped from both. The rule that no spawn/socket/clone cost creeps back into the per-lane tier is enforced at runtime by `tests/support/fast-tier-guard.mjs`, so a violation fails the offending suite rather than only review.

**CSS and HTML are not exercised by this fast unit tier.** `tools/report-fast-style-coverage.sh` compares the branch tip to its `origin/main` merge-base and emits `fast-gate: unmapped: <path>` for *each* changed `.css` or `.html` file before the suites run. Fleet-check surfaces those markers as a **COVERAGE WARNING**, even though its shared changed-file extractor does not classify these extensions. If the base cannot be determined, the gate explicitly reports `fast-gate: unknown:` rather than claiming coverage. A passing unit gate with these notices is not visual/browser verification.

For demo style or markup changes, drive the affected demo in Chromium, assert the actual interaction or computed styles at relevant viewport sizes and colour schemes, and capture a screenshot. Use a focused browser check during implementation; do not add a full browser run to the fast unit tier. On landing, the merger runs the full gate (`npm test` including `npm run test:demo-restore` and the middle unit tier, `npm run test:packed`, `npm run test:wikipedia`, `npm run gate:research` - the research publication leg, measured 78-89 s on the 2-vCPU fleet VM at host loads 2.6-6.9 and held to its own 300 s bound) once on the merged result. The focused restore test drives Chromium and is deliberately excluded from `test:fast`; its changed file may appear as an unmapped fast-gate coverage warning, but it runs in the full gate. The compute lab is separate; when it changes, drive its controls and inspect the rendered report as well.

`npm run test:compute` is that lab's focused browser check (real click, 100k × 128
synthetic corpus, storage roundtrips, four-path top-k, near-tie fixture, screenshots);
measured **62 s on the 2-vCPU fleet VM**, so it is deliberately in neither the fast unit
tier nor the merger's full gate. It is host-load sensitive — the same check has measured
57–96 s, and its internal 240 s run bound was hit while another lane held the heavy slot —
so run it on a machine that is not saturated. Its pure numeric contract — corpus determinism, cosine
definition, tie ordering, and the comparison instrument's mutant rejection — is covered
by `tests/unit/compute-engines.test.mjs` in the fast tier, which launches no browser.

## Merged gate time: four legs, 2236 s measured (idb-vector-9dze)

The four-leg gate passed on tree `4467a83` (merge `0878a4c`, 2026-10-31) in **2236 s** with exit 0 and
2 s of heavy-slot wait. The bound in force that day was `CHECK_TIMEOUT=2400`, so the run spent **93% of
it and had 164 s left**: that margin is not a margin, it is one load spike from failing a correct tree
with exit 124. Host load was 11.24 (1 min), as the packed leg recorded. The bound in force **now** is
**3600 s** (`~/.fleet/idb-vector-check.conf`), i.e. 1364 s of headroom on this same measurement - every
2026-10-31 number in this section was measured under the then-2400 s bound, not against the current
one.

The leg costs are mined from that run's log and from the mtimes of the evidence directories each leg
prints (`/tmp/idb-vector-browser-*`, `/tmp/idb-demo-restore-*`, `/tmp/idb-packed-snapshot-*`,
`/tmp/idb-wikipedia-demo-*`), whose screenshot and report writes bracket each leg to about ±20 s. No
gate was re-run to produce them: they are one run's wall clock, with a second sample of the same
command on a quieter host two days earlier.

| leg | 2026-10-31 wall (gate 2236 s, load 11.24) | share | 2026-10-29 sample (gate 1681 s, load 6.07) |
| --- | --- | --- | --- |
| `npm test` | 1163 s | 52% | 783 s |
| `npm run test:packed` | 391 s | 17% | 299 s |
| `npm run test:wikipedia` | 469 s | 21% | 449 s |
| `npm run gate:research` | 213 s | 10% | 150 s |

Both columns are four consecutive brackets that tile their gate's wall clock, so each column sums to
the gate's own reported time: 1163 + 391 + 469 + 213 = 2236 s, and 783 + 299 + 449 + 150 = 1681 s. The
2026-10-29 brackets run 10:58:15 -> 11:11:18 -> 11:16:17 -> 11:23:46 -> 11:26:16: the first is the
gate's start line, the next three come from `/tmp/idb-demo-restore-ahjt3b` (last screenshot 11:10:27.98
plus the middle tier's 45.4 s), `/tmp/idb-packed-snapshot-kgUs0o` (`packed-snapshot.png` 11:16:16.38)
and `/tmp/idb-wikipedia-demo-sBQM3g` (`report.json` 11:23:42.48), and the last is the gate's own
reported 1681 s after its 10:58:15 start.

Inside `npm test`, all of which the merged gate pays again on top of the lane's fast and middle runs:
`tests/browser.mjs` 160 s; the five further browser drivers (`validation`, `candidates`, `eligibility`,
`snapshot-isolation`, `side-store`) plus `cdp-orphans` 628 s; `test:demo-restore` 278 s, of which the
restore itself is 202.8 s; `test:middle` 95.9 s (its self-reported `duration_ms`). Those four brackets
sum to 1161.9 s, so 1.1 s of the 1163 s is npm dispatch and process teardown between them.

Inside `test:wikipedia`: 469 s wall, of which the phases it prints account for 260.0 s - corpus and
model load phases 199.2 s (fresh 250-passage load 112.4 s, restore of the stored 2,000-passage corpus
55.0 s, load after an injected write failure 23.8 s, injected-write-failure 5.5 s, offline load
refused 2.5 s), probes and clears 34.8 s, queries 25.7 s, offline network emulation 0.3 s - and the
remaining 209 s is browser start, five full-page screenshots and chromium teardown (the log records the
teardown wait: `chromium process group ... did not exit; close() left it to the reaper`). On the
quieter host the same leg took 449 s on 296 s of phases, so its non-phase overhead tracks load - 209 s
here against 153 s there - while its phases ran 36 s *slower* on the quieter host.

**What the table rules out.** No single leg dominates, so trimming one leg is not the fix, and moving
one leg to a nightly would not make the remaining gate's bound trustworthy: the cost is spread
52/17/21/10, and the total grew 1.33x (1681 -> 2236 s) as load went 6.07 -> 11.24, with `npm test` +49%,
`test:packed` +31%, `gate:research` +42% and `test:wikipedia` +4%. Inside the largest leg no single driver
dominates either - the widest item is the 628 s of six browser drivers that each launch Chromium and
seed their own dataset, and each one covers a different contract. The corpus loads in `test:wikipedia`
are likewise distinct, not duplicates: a fresh load, a restore of the stored corpus, and a load after
an injected write failure are three different paths, so there is no redundant second load to delete.

**Why the bound is not repairable by trimming.** The gate's own sub-legs grant themselves more time
than it: `test:wikipedia` gives each of its five load phases a 600 s budget and every other page phase
300 s - 3000 s for the load phases alone - and `gate:research` carries its own 300 s bound, so the
inner budgets are sized for a loaded host while the outer one was not. A load phase taking 277 s, well
inside its 600 s budget and unremarkable on a host at load 11, would have taken the 2236 s run to
2400.6 s - past the 2400 s bound then in force - and killed a correct tree with exit 124, because the
outer bound fires before the inner ones that were designed to be generous. The total bound has to be
consistent with what the legs are allowed to spend, and the answer is a total bound, not a smaller
internal budget that fails slow-but-correct trees.

**The bound in force: `CHECK_TIMEOUT=3600`.** The coordinator raised it from 2400 s after this
measurement. The conf lives outside this repo (`~/.fleet/idb-vector-check.conf`), so this file records
the number and the arithmetic rather than enforcing it:

- 2236 s measured leaves **1364 s** of headroom, so the bound is 1.61x the measurement.
- Worst case **3428 s**: any two of the five wikipedia load phases running to their full 600 s budget
  costs at most an extra 1192 s, and the worst pair is the two smallest (5.5 s and 2.5 s):
  (600 - 5.5) + (600 - 2.5) = 1192 s, giving 2236 + 1192 = 3428 s - still **172 s inside** 3600 s.
  That is the honest ceiling: the pair that can blow together by the most still lands inside the bound.
- It does not cover everything: three blown load-phase budgets reach 4004 s (the third smallest phase
  is 23.8 s, +576 s), and a leg that regresses outright would red the gate whatever the bound. That
  is a real anomaly rather than an ordinary load spike, which is the right place for the limit to sit.
- No repo file changes with it: `tests/wikipedia-demo.mjs` pins its own 600 s and 300 s wait constants
  (`READY_WAIT_MS`, `PAGE_WORK_WAIT_MS`) and `gate:research` keeps its `300s` timeout. `CHECK_CMD` and
  `CHECK_FAST_TIMEOUT` are unchanged.

A re-measurement replaces these numbers here and in the tier table above; the bound moves with them,
not ahead of them.

## Research publication leg (`npm run gate:research`)

`npm run test:research` drives `tests/research.mjs`, the publication acceptance run: Marked parses
`research/architecture.md`, a loopback server serves the report and the demo with an allowlist, real
Chromium opens the page over CDP, and a receipt is written. Until idb-vector-lk98 that command was
named by no gate - not `test:fast`, not `test:middle`, not `npm test`, not the Pages workflow (which
only runs `build:research`) - so the staged publication path was covered only when a human
remembered it, and `tests/unit/research-driver-contract.test.mjs` (the fast-tier pin from
idb-vector-isyy) deliberately covers the static contract and not the browser behaviour.

**Measured, then gated** (idb-vector-lk98). One bounded run in a lane worktree on the 2-vCPU fleet
VM, 2026-10-29: **78 s wall, exit 0**, host load 2.6 (1 min) rising to 5.0 during the run, and
`pgrep -c chrome` = 0 afterwards - no browser left behind. That is bounded (well under 300 s) and it
passed, so the remedy is a gate leg rather than a manual checklist: the run is host-load sensitive
but not flaky, and 78 s is 3% of the gate's then-2400 s bound. Inside the merged gate the same leg measured
150 s at host load 6.07 (2026-10-29) and 213 s at load 11.24 (2026-10-31, tree `4467a83`) - still well
inside its 300 s bound, and 10% of the measured four-leg gate. Alone among the optional browser runs it
needs no network, no credentials and no pinned model download (the `--links` mode is the part that
fetches published sources, and that stays manual - see below).

The repo's half is the script: `"gate:research": "timeout --kill-after=15s 300s node tests/research.mjs"`.
The bound is explicit and ~4x the measurement, so a real regression fails as a named timeout instead
of a stall; it is still under a quarter of `CHECK_TIMEOUT`. `npm run test:research` remains the
unbounded manual form, and `tests/unit/research-driver-contract.test.mjs` pins both scripts so the
gate leg cannot be silently renamed away. The leg is deliberately **not** in the fast or middle tier:
it launches Chromium, which the fast-tier shape rule forbids and the fast-tier guard would reject.

The wrapper needs the driver's own signal handling: `timeout` signals only the Node process, while
the browser leads its own process group, so a bare wrapper leaves renderer, GPU, zygote and crashpad
helpers running (16 processes survived a probe - the orphan class of idb-vector-6i3). The driver
therefore handles SIGTERM/SIGINT by closing the page and the server before exiting non-zero. The
receipt and screenshots go to `.cache/research-evidence/` (git-ignored); the committed
`reports/research-publication.json` is not rewritten by a run, so the leg leaves the worktree clean.

**What this leg covers that no other automated test does.** Real browser and CDP: the allowlist
answering actual 200s for the report, its Markdown source, `demo/style.css` and the demo's whole
module closure (`/demo/`, `/utils/`, `/index.js`); the rendered report's citation targets,
headings, tables and evidence labels; layout and computed colours at 1280 and 390 px in light and
dark; 29 real pointer clicks on the table-of-contents entries with the target scrolled into view;
and the demo booting its module after a top-level `await` on `indexedDB.open` - the module-closure
failure class of idb-vector-zyd, where `/demo/` answered 200 while the modules it imports 404'd and
the receipt still said healthy. The fast-tier contract test proves the allowlist and the closure
agree in source; only this run proves the browser actually renders and executes them.

**`--links` stays manual.** `npm run test:research -- --links` additionally fetches every external
citation, records failures instead of hiding them, and visits three published sources in the
browser. That needs the network and reaches third-party publishers, so it is a publisher's check
(README) and not a gate leg. Run it after deploying the report, together with
`RESEARCH_URL=<published url> npm run test:research` - the gate only ever proves the worktree copy.

**The conf lives outside the repo.** `~/.fleet/idb-vector-check.conf` holds `CHECK_CMD`; the merger
must append `&& npm run gate:research` to it for the leg to run at merge time. The repo cannot
enforce that (the file is not tracked here and has been clobbered before - see its own warning
header), which is why the script, its bound and this section are pinned and reviewed on the branch.

## Packed-snapshot stress measurement (not in the full gate)

`npm run test:packed` is the merger's packed-snapshot **correctness** leg: contract checks, the 2000x384
committed real corpus, a 1000x128 seeded synthetic corpus, exact byte comparison of cached ranking against
the plain scan, rollback and optional whitening. It must stay inside the full gate's budget.

The 100000x128 measurement used to live in that same file. It is a benchmark, not a gate: it wrote
100,000 vectors in batches of 1000 and timed three comparisons, which pushed the full gate past **900 s at
host load ~10** — 37% of its then-2400 s allowance — while the small corpora already cover the exactness claim
(idb-vector-bqw, ADR idb-vector-80j). It now lives in `tests/packed-snapshot-stress.mjs`:

- `npm run measure:packed-snapshot` — opt-in, writes its report and screenshot into a **unique directory
  it prints and keeps** (`PACKED_SNAPSHOT_STRESS_DIR` redirects it, `PACKED_SNAPSHOT_STRESS_COUNT` resizes
  the corpus for a smoke run). It asserts bit-identical keys, scores and order against the plain scan at
  high cardinality, so the size-dependent check still exists and still fails loudly.
- `.github/workflows/packed-stress.yml` owns the schedule: weekly, plus a push touching
  `utils/packed-snapshot.js`, `utils/sortedarray.js`, `index.js`, `tools/demo-server.mjs` or the stress
  test itself. It uploads the evidence directory as an artifact. Owner: the workflow (CI), not a lane —
  no implementer or merger run pays its cost.

Do not move it back into `npm test`, `test:packed` or the fast tier, and do not "fix" a slow packed leg by
raising `CHECK_TIMEOUT`: it measured 391 s of the four-leg gate's 2236 s (2026-10-31), so it is not what
fills the gate and a longer bound would only hide its cost. If the correctness leg itself starts
approaching the budget, the answer is a smaller corpus with a pointer to the stress command, not a longer
bound. Whether the *whole* gate needs a longer bound is a different question, answered by measurement in
[Merged gate time](#merged-gate-time-four-legs-2236-s-measured-idb-vector-9dze) above.
