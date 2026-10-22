import { mkdtempSync } from 'node:fs';
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
