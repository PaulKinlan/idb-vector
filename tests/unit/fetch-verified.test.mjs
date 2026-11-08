import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// tools/prepare-real-vectors.py imports numpy and h5py, so it cannot load in a bare python3 (the venv
// is .cache/vector-python, built by `npm run real:prepare`). The download-and-verify step it now calls
// - tools/fetch_verified.py, idb-vector-pgs7 - is stdlib only, so the ordering is exercised there by
// tests/python/test_fetch_verified.py: a wrong-digest payload must leave the trusted cache path ABSENT,
// a right-digest payload must land on it, and a pre-existing corrupt file must be reported and kept.
// This wrapper spawns python3, which is why the suite is listed in `middle` in
// tools/unit-tier-suites.sh rather than the fast lane (docs/speed.md, tests/support/fast-tier-guard.mjs).
const suite = resolve('tests/python/test_fetch_verified.py');

// The ordering cases are the contract: losing one silently is the regression this suite exists for.
const expectedCases = [
  'test_a_mismatched_payload_raises_naming_both_digests_and_leaves_the_cache_path_absent',
  'test_a_pre_existing_verified_file_is_reused_without_downloading',
  'test_absent_cache_path_is_downloaded_and_installed_from_verified_bytes',
  'test_b_a_matching_payload_is_installed_at_the_cache_path',
  'test_c_a_pre_existing_corrupt_file_is_reported_and_preserved_not_trusted',
];

test('the download is hashed as a .partial and only then renamed onto the trusted cache path', () => {
  let output;
  try {
    output = execFileSync('python3', [suite], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    assert.fail(`python3 ${suite} failed (status ${error.status}):\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
  const cases = [...output.matchAll(/^(\w+) \([^)]*\) \.\.\. (\w+)$/gm)].map(([, name, status]) => ({ name, status }));
  assert.deepEqual(cases.map(({ name }) => name).sort(), expectedCases, 'every ordering case runs');
  for (const { name, status } of cases) assert.equal(status, 'ok', `${name} must pass`);
  assert.match(output, new RegExp(`Ran ${expectedCases.length} tests`), 'no case is skipped by discovery');
});
