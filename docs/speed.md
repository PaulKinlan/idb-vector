# Gate speed and demo coverage

The implementer fast gate (`fleet-check --fast`) runs `tools/fast-gate.sh` with a 120-second bound. It runs the independent `tests/unit/*.test.mjs` suites without launching Chromium; the merger runs the full gate once on its merged tree. Keep unit tests independent of test order, host state and other worktrees. A new unit file should not add a browser launch to this tier.

**CSS and HTML are not exercised by this fast unit tier.** `tools/report-fast-style-coverage.sh` compares the branch tip to its `origin/main` merge-base and emits `fast-gate: unmapped: <path>` for *each* changed `.css` or `.html` file before the suites run. Fleet-check surfaces those markers as a **COVERAGE WARNING**, even though its shared changed-file extractor does not classify these extensions. If the base cannot be determined, the gate explicitly reports `fast-gate: unknown:` rather than claiming coverage. A passing unit gate with these notices is not visual/browser verification.

For demo style or markup changes, drive the affected demo in Chromium, assert the actual interaction or computed styles at relevant viewport sizes and colour schemes, and capture a screenshot. Use a focused browser check during implementation; do not add a full browser run to the fast unit tier. On landing, the merger runs the full gate (`npm test` including `npm run test:demo-restore`, `npm run test:packed`, `npm run test:wikipedia`) once on the merged result. The focused restore test drives Chromium and is deliberately excluded from `test:fast`; its changed file may appear as an unmapped fast-gate coverage warning, but it runs in the full gate. The compute lab is separate; when it changes, drive its controls and inspect the rendered report as well.

`npm run test:compute` is that lab's focused browser check (real click, 100k × 128
synthetic corpus, storage roundtrips, four-path top-k, near-tie fixture, screenshots);
measured **62 s on the 2-vCPU fleet VM**, so it is deliberately in neither the fast unit
tier nor the merger's full gate. Its pure numeric contract — corpus determinism, cosine
definition, tie ordering, and the comparison instrument's mutant rejection — is covered
by `tests/unit/compute-engines.test.mjs` in the fast tier, which launches no browser.
