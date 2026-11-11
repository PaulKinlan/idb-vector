// tests/unit/gate-wiring.test.mjs — the pin over the fleet gate's command wiring (idb-vector-cnyx).
//
// The merger's gate runs whatever ~/.fleet/idb-vector-check.conf says, and that file is outside git:
// the idb-vector coord lane maintains it by hand. In-repo tests pinned the 3600 s timeout
// (tests/unit/wait-budget.test.mjs) and the `gate:research` script
// (tests/unit/research-driver-contract.test.mjs), but nothing asserted the four CHECK_CMD legs or
// CHECK_FAST_CMD as a set - so a conf that was clobbered (on 2026-10-13 an `agents
// tools/check-cmd.sh --install` run put CHECK_CMD="bash tools/full-gate.sh" here and every full gate
// exited 127), truncated, or simply missing a leg still produced a verdict while silently skipping
// test:packed, test:wikipedia or gate:research.
//
// tools/gate-wiring.json is now the one declaration of that wiring and tools/gate-wiring.mjs --conf
// prints the conf it makes. The tests below read only those two small files and the conf - no spawn,
// no socket - so they cost nothing in the fast tier. FLEET_CHECK_CONF is the seam: it points the pin
// at a fixture copy of the conf, so review can prove each assertion bites without touching the file
// the gate reads.
//
// THE SKIP IS VISIBLE, NOT SILENT. A checkout without the conf (CI, a fresh clone) is not a failure -
// no test can install a file outside the repo - so the effective-conf test skips. It skips with a
// reason rather than returning early: node:test prints the `# SKIP <reason>` line beside that test and
// counts it in its `skipped` total, so the tier's output says a pin did not run instead of reporting
// `ok` for one that asserted nothing. The generator round-trip test still runs there, so the
// declaration and the parser stay covered on a machine that has no conf.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatCheckConf, parseCheckConf, readGateWiring } from '../../tools/gate-wiring.mjs';

const WIRING = readGateWiring();

// Where the conf that owns CHECK_CMD lives. FLEET_CHECK_CONF redirects it at a copy.
const CHECK_CONF = process.env.FLEET_CHECK_CONF || join(homedir(), '.fleet', 'idb-vector-check.conf');
const OWNERSHIP =
  `${CHECK_CONF} is outside this repo and hand-maintained by the idb-vector coord lane; ` +
  'regenerate it from the declaration with `node tools/gate-wiring.mjs --conf` (never with the ' +
  'agents-factory `tools/check-cmd.sh --install`, which rewrote it with a script this repo does not have)';

/** The CHECK_CMD legs of a parsed conf, split the way the gate's shell runs them. */
const legsOf = (checkCmd) =>
  String(checkCmd ?? '')
    .split(/\s*&&\s*/)
    .map((leg) => leg.trim())
    .filter(Boolean);

test('the generator emits a conf its own parser reads back as tools/gate-wiring.json (idb-vector-cnyx)', () => {
  // The remedy every red below prints is "regenerate the conf", so a generator that emitted something
  // this parser could not read would make that remedy produce a second red. Asserted here rather than
  // only against the real conf, so it holds on a checkout that has no conf at all.
  assert.deepEqual(
    parseCheckConf(formatCheckConf(WIRING)),
    {
      checkCmd: WIRING.checkCmdLegs.join(' && '),
      checkFastCmd: WIRING.checkFastCmd,
      checkTimeoutSeconds: WIRING.checkTimeoutSeconds,
      checkFastTimeoutSeconds: WIRING.checkFastTimeoutSeconds,
    },
    'tools/gate-wiring.mjs --conf must emit a conf that tools/gate-wiring.mjs parseCheckConf reads back as the same wiring (idb-vector-cnyx)',
  );
});

test(
  'the effective gate conf carries every leg, the fast command and both bounds tools/gate-wiring.json declares (idb-vector-cnyx)',
  {
    skip: existsSync(CHECK_CONF)
      ? false
      : `no gate conf at ${CHECK_CONF}, so the effective gate wiring cannot be compared with tools/gate-wiring.json: SKIPPED, not passed - ${OWNERSHIP}`,
  },
  async () => {
    const conf = parseCheckConf(await readFile(CHECK_CONF, 'utf8'));

    // Missing and unexpected legs are named before the order check: a clobbered conf is usually one
    // leg short (or the whole four replaced), and the ordered comparison alone would report a diff
    // without saying which gate leg no longer runs.
    const legs = legsOf(conf.checkCmd);
    const missing = WIRING.checkCmdLegs.filter((leg) => !legs.includes(leg));
    assert.deepEqual(
      missing,
      [],
      `CHECK_CMD in ${CHECK_CONF} is missing the leg(s) ${JSON.stringify(missing)}; tools/gate-wiring.json declares, in this order, ${JSON.stringify(WIRING.checkCmdLegs)} and this conf has ${JSON.stringify(legs)}. A missing leg is a gate that reports a verdict for work it never ran (the clobber class this pin exists for: idb-vector-cnyx). ${OWNERSHIP}`,
    );
    const unexpected = legs.filter((leg) => !WIRING.checkCmdLegs.includes(leg));
    assert.deepEqual(
      unexpected,
      [],
      `CHECK_CMD in ${CHECK_CONF} runs the leg(s) ${JSON.stringify(unexpected)}, which tools/gate-wiring.json does not declare (it declares ${JSON.stringify(WIRING.checkCmdLegs)}). A leg no one declared is either a moved gate or a foreign gate: if it belongs in the merged gate, add it to checkCmdLegs and regenerate; if not, remove it. ${OWNERSHIP}`,
    );
    assert.deepEqual(
      legs,
      WIRING.checkCmdLegs,
      `CHECK_CMD in ${CHECK_CONF} runs the right legs in the wrong order: ${JSON.stringify(legs)}, not ${JSON.stringify(WIRING.checkCmdLegs)}. The order is part of the declaration in tools/gate-wiring.json, so a reordering is a reviewed edit there. ${OWNERSHIP}`,
    );

    assert.equal(
      conf.checkFastCmd,
      WIRING.checkFastCmd,
      `CHECK_FAST_CMD in ${CHECK_CONF} is ${JSON.stringify(conf.checkFastCmd)}, not ${JSON.stringify(WIRING.checkFastCmd)} as tools/gate-wiring.json declares. The fast gate is the per-lane tier: another script here means the branch was verified by something other than the tier its tests are written for (idb-vector-cnyx). ${OWNERSHIP}`,
    );

    assert.equal(
      conf.checkTimeoutSeconds,
      WIRING.checkTimeoutSeconds,
      `CHECK_TIMEOUT in ${CHECK_CONF} is ${JSON.stringify(conf.checkTimeoutSeconds)} s, not the ${WIRING.checkTimeoutSeconds} s tools/gate-wiring.json declares (docs/speed.md sizes it against the 2236 s measured merged gate, idb-vector-9dze). tests/lib/wait-budget.mjs GATE_CHECK_TIMEOUT_MS and every wait budget derived from it move with this number, so a bound lowered here silently shortens three drivers' budgets: change the declaration and docs/speed.md together, with a measurement, or put the conf back. ${OWNERSHIP}`,
    );

    assert.equal(
      conf.checkFastTimeoutSeconds,
      WIRING.checkFastTimeoutSeconds,
      `CHECK_FAST_TIMEOUT in ${CHECK_CONF} is ${JSON.stringify(conf.checkFastTimeoutSeconds)} s, not the ${WIRING.checkFastTimeoutSeconds} s tools/gate-wiring.json declares (docs/speed.md prices the fast tier against it). A lower fast bound turns a loaded host into a fast-gate failure that names no suite; a higher one lets the tier that must stay cheap grow unnoticed. ${OWNERSHIP}`,
    );
  },
);
