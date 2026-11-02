// The research acceptance driver (tests/research.mjs) serves a small allowlist of worktree files over
// loopback: exact files for the report and the library entry point, directory prefixes for the demo's
// module closure. That allowlist is lexical - `resolve()` normalises a string and never touches the
// filesystem - so a symlink placed inside an allowed directory was served from wherever it pointed,
// while the driver's header and receipt still claimed everything else in the worktree was unreachable
// (idb-vector-gb9n). This is the layer underneath, mirroring tools/wiki-demo-server.mjs after
// idb-vector-r5wg: normalise, compare lexically, then realpath() both sides and require the RESOLVED
// target to stay inside the RESOLVED allowed directory.
//
// The allowlist is a parameter rather than a literal here because the driver owns it and
// tests/unit/research-driver-contract.test.mjs pins it from the driver's own source.
//
// Returns the absolute path to read, or null to refuse. A file inside an allowed directory that simply
// does not exist resolves to itself and is returned, so the caller answers it exactly as before this
// change (readFile's ENOENT) instead of turning "missing" into a confinement refusal. A lexically
// out-of-root candidate is refused before any realpath call, which is the same check the driver made
// inline; it stays as defence in depth.
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export async function acceptanceAsset(path, root, { assetFiles, assetDirs }) {
  const exact = assetFiles.get(path);
  if (exact !== undefined) return exact;
  let base;
  try {
    base = await realpath(root);
  } catch {
    return null;
  }
  // Resolve against the realpath()ed root, so a worktree reached through a symlink compares equal to
  // itself in the prefix tests below.
  const candidate = resolve(base, '.' + path);
  if (!candidate.startsWith(base + sep)) return null;
  const allowedDir = assetDirs
    .map((prefix) => resolve(base, prefix.slice(1)))
    .find((dir) => candidate.startsWith(dir + sep));
  if (allowedDir === undefined) return null;
  const target = await realpath(candidate).catch(() => candidate);
  // Root first, then the allowed directory itself realpath()ed: an allowed directory that is ITSELF a
  // link out of the worktree must not widen the allowlist to its resolved contents.
  if (!target.startsWith(base + sep)) return null;
  const confinedDir = await realpath(allowedDir).catch(() => allowedDir);
  return target.startsWith(confinedDir + sep) ? target : null;
}
