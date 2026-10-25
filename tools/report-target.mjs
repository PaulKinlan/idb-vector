import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

// A measurement driver whose report path is a fixed name under os.tmpdir() lets two concurrent
// runs (two lanes, or a retry beside a stuck run) clobber each other's report mid-write
// (idb-vector-8oy). Unless the caller pinned a path, each run gets its own mkdtemp directory;
// the caller removes the returned dir when it is done. A pinned path is used verbatim and owns
// no directory, so there is nothing to clean up.
export function reportTarget(pinned, prefix, name = 'report.json') {
  if (pinned) return { path: pinned, dir: null };
  const dir = mkdtempSync(join(os.tmpdir(), prefix));
  return { path: join(dir, name), dir };
}

// Same guarantee for a driver whose output is a DIRECTORY of evidence (screenshots, several JSON
// files): a pinned directory is created and kept as before; otherwise the run gets a unique
// mkdtemp directory, so two concurrent runs never share a file name (idb-vector-8oy). Evidence is
// kept either way - deleting it would defeat the run - and the caller prints the path.
export function runDir(pinned, prefix) {
  if (pinned) {
    mkdirSync(pinned, { recursive: true });
    return { dir: pinned, owned: false };
  }
  return { dir: mkdtempSync(join(os.tmpdir(), prefix)), owned: true };
}

// Where a measurement driver's screenshot/evidence files go for a given report target. An unpinned
// target owns its unique run directory, so the evidence belongs there beside the report. A PINNED
// path normally points at a TRACKED report (reports/packed-snapshot.json): writing an untracked png
// beside it advances the worktree digest and fleet-check reads the tree as mutated mid-run (STALE,
// the reason the report left the repo in idb-vector-006), so a pinned target gets its own unique
// KEPT directory instead (idb-vector-09x). Exported rather than inlined in the driver so the rule is
// pinned by a test instead of by a comment that says the evidence survives (idb-vector-tqo).
export function evidenceDir(target, prefix = 'idb-packed-screenshot-') {
  return target.dir ?? runDir(undefined, prefix).dir;
}
