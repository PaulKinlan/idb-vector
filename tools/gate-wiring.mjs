#!/usr/bin/env node
// The fleet gate's wiring for this repo, declared once and printed as a conf (idb-vector-cnyx).
//
// THE CONFIGURATION IS NOT IN THIS REPO. The merger's gate runs whatever
// ~/.fleet/idb-vector-check.conf says: a local file outside git, hand-maintained by the idb-vector
// coord lane. That file has been clobbered: on 2026-10-13 an `agents tools/check-cmd.sh --install`
// run (the agents-factory installer, a DIFFERENT repo) rewrote it with the agents-factory gate,
// CHECK_CMD="bash tools/full-gate.sh". idb-vector has no such script, so every idb-vector full gate
// exited 127 - and a partial or truncated conf fails the same way silently, reporting a verdict while
// skipping a leg. Never point that installer at this repo's conf.
//
// So the expected wiring is declared in tools/gate-wiring.json - the four CHECK_CMD legs in order,
// CHECK_FAST_CMD, CHECK_TIMEOUT and CHECK_FAST_TIMEOUT - and this module is the one reader of it:
//   node tools/gate-wiring.mjs --conf     print the conf body for ~/.fleet/idb-vector-check.conf
// The generator exists ONLY so the conf's owner can regenerate it exactly; the repo cannot install
// the file. tests/unit/gate-wiring.test.mjs holds the effective conf to the same declaration in the
// fast tier, so a clobbered, truncated or abbreviated conf is caught on the branch instead of
// shipping a green but incomplete merger verdict.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const GATE_WIRING_PATH = fileURLToPath(new URL('./gate-wiring.json', import.meta.url));

// The declaration's fields, and the conf variable each one writes. `note` is the JSON file's own
// header and is carried through validation untouched.
const CONF_FIELDS = {
  CHECK_CMD: 'checkCmd',
  CHECK_FAST_CMD: 'checkFastCmd',
  CHECK_TIMEOUT: 'checkTimeoutSeconds',
  CHECK_FAST_TIMEOUT: 'checkFastTimeoutSeconds',
};
const DECLARED_KEYS = ['checkCmdLegs', 'checkFastCmd', 'checkTimeoutSeconds', 'checkFastTimeoutSeconds'];
const BOUND_KEYS = new Set(['CHECK_TIMEOUT', 'CHECK_FAST_TIMEOUT']);

// A command reaches the gate as a shell assignment that the gate then sources, so it has to survive
// that round trip unchanged: a quote, a backslash, a newline, a `$` or a backtick would end the
// assignment early or be expanded by the shell, and the gate would run something nobody declared.
const UNSAFE_IN_CONF = /["\\\n$`]/;

function assertDeclaredCommand(value, key) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`tools/gate-wiring.json: ${key} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  if (UNSAFE_IN_CONF.test(value)) {
    throw new Error(
      `tools/gate-wiring.json: ${key} is ${JSON.stringify(value)}; it is written into the conf as a double-quoted shell assignment, so it cannot contain a quote, a backslash, a newline, $ or a backtick`,
    );
  }
}

/** Refuse a declaration the conf cannot carry, so the generator cannot emit a conf its own parser misreads. */
function assertWiring(wiring) {
  if (wiring === null || typeof wiring !== 'object' || Array.isArray(wiring)) {
    throw new Error(`tools/gate-wiring.json must hold one object, got ${JSON.stringify(wiring)}`);
  }
  const unknown = Object.keys(wiring).filter((key) => key !== 'note' && !DECLARED_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `tools/gate-wiring.json has unknown key(s) ${JSON.stringify(unknown)}; the expected wiring keys are ${JSON.stringify(DECLARED_KEYS)} - join a leg onto checkCmdLegs rather than adding a field the generator would ignore`,
    );
  }
  const missing = DECLARED_KEYS.filter((key) => !(key in wiring));
  if (missing.length > 0) {
    throw new Error(`tools/gate-wiring.json is missing ${JSON.stringify(missing)}; the expected wiring keys are ${JSON.stringify(DECLARED_KEYS)}`);
  }
  if (!Array.isArray(wiring.checkCmdLegs) || wiring.checkCmdLegs.length === 0) {
    throw new Error('tools/gate-wiring.json: checkCmdLegs must be a non-empty array of commands, in gate order');
  }
  wiring.checkCmdLegs.forEach((leg, index) => assertDeclaredCommand(leg, `checkCmdLegs[${index}]`));
  assertDeclaredCommand(wiring.checkFastCmd, 'checkFastCmd');
  for (const key of ['checkTimeoutSeconds', 'checkFastTimeoutSeconds']) {
    if (!Number.isInteger(wiring[key]) || wiring[key] <= 0) {
      throw new Error(`tools/gate-wiring.json: ${key} must be a positive whole number of seconds, got ${JSON.stringify(wiring[key])}`);
    }
  }
  return wiring;
}

/** The declared wiring, validated. */
export function readGateWiring(path = GATE_WIRING_PATH) {
  let wiring;
  try {
    wiring = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read the gate wiring declaration at ${path}: ${error.message}`);
  }
  return assertWiring(wiring);
}

/** The conf body the declaration makes, ready to write to ~/.fleet/idb-vector-check.conf. */
export function formatCheckConf(wiring) {
  assertWiring(wiring);
  return [
    '# idb-vector gate command configuration, from tools/gate-wiring.json (idb-vector-cnyx).',
    '# This file is OUTSIDE git and hand-maintained by the idb-vector coord lane, not by a test and not',
    '# by an installer. Regenerate it from the one declaration with:',
    '#     node tools/gate-wiring.mjs --conf > ~/.fleet/idb-vector-check.conf',
    '# DO NOT write it with the agents-factory installer (`agents tools/check-cmd.sh --install`): on',
    '# 2026-10-13 that rewrite put CHECK_CMD="bash tools/full-gate.sh" here, a script idb-vector does',
    '# not have, and every idb-vector full gate exited 127 while still reporting a verdict.',
    `CHECK_CMD="${wiring.checkCmdLegs.join(' && ')}"`,
    `CHECK_FAST_CMD="${wiring.checkFastCmd}"`,
    `CHECK_TIMEOUT=${wiring.checkTimeoutSeconds}`,
    `CHECK_FAST_TIMEOUT=${wiring.checkFastTimeoutSeconds}`,
    '',
  ].join('\n');
}

/**
 * The wiring a conf sources, as the four values above. Missing assignments are absent from the
 * result (the caller asserts presence); a bound that is not a whole number is returned as written, so
 * a red prints what the file says instead of NaN. Repeated assignments follow the shell: last wins.
 */
export function parseCheckConf(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const assignment = /^(CHECK_CMD|CHECK_FAST_CMD|CHECK_TIMEOUT|CHECK_FAST_TIMEOUT)=(.*)$/.exec(line);
    if (!assignment) continue;
    const [, key, raw] = assignment;
    values[CONF_FIELDS[key]] = BOUND_KEYS.has(key)
      ? (/^\d+$/.test(raw) ? Number(raw) : raw)
      : raw.replace(/^"(.*)"$/, '$1');
  }
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, ...rest] = process.argv.slice(2);
  if (flag === '--conf' && rest.length === 0) {
    process.stdout.write(formatCheckConf(readGateWiring()));
  } else {
    console.error('usage: node tools/gate-wiring.mjs --conf   # print the fleet gate conf for ~/.fleet/idb-vector-check.conf');
    process.exit(2);
  }
}
