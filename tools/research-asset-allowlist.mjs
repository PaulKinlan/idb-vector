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
// The two branches below are one rule, not two: an exact allowlisted file is realpath()ed and
// root-checked exactly like a name under an allowed directory. Returning the map value unresolved let
// a symlinked index.js be read from outside the worktree while tools/wiki-demo-server.mjs refused the
// same shape (idb-vector-jz65). tests/unit/asset-confinement-parity.test.mjs asserts that both
// helpers answer alike for one table of shapes.
//
// Returns the RESOLVED absolute path to read, or null to refuse. realpath() is the only thing that can
// tell a link from its target, so its answer is the answer: a candidate that cannot be resolved - a
// dangling symlink under demo/ was served by returning the unresolved path here, and the read landed
// outside the worktree as soon as that target appeared (idb-vector-gb9n review) - is refused, never
// passed through as the path the caller would then read. A lexically out-of-root candidate is refused
// before any realpath call, which is the same check the driver made inline; it stays as defence in
// depth.
//
// The driver never needs this to answer for a file that does not exist: tests/research.mjs probes its
// allowed set for 200s and tests/unit/research-driver-contract.test.mjs asserts every one of those
// paths exists in the checkout, so refusal here can only turn a broken fixture into a 404 that fails
// the driver's own allowed-asset loop loudly. A worktree root or allowed directory that cannot be
// resolved is a configuration error for the same reason, and is refused rather than degraded to a
// lexical-only compare.
//
// null has to keep ONE meaning - "refuse" - so a realpath() that FAILS is not the same answer as one
// that succeeds and lands outside. ENOENT and ENOTDIR are refusals ("no such name"); EACCES, EIO and
// ELOOP are the filesystem failing to answer, and they are thrown so the driver's handler answers
// 500 instead of dressing a server fault as the refusal, exactly as tools/wiki-demo-server.mjs
// confinedFile() does (idb-vector-bc9t).
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// The two error codes that mean "no such name", the same pair tools/wiki-demo-server.mjs names: ENOENT
// for an absent target, ENOTDIR for a path whose component is a file. Everything else a realpath() can
// raise is the filesystem failing to answer.
function absent(error) {
  const code = error?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function resolved(target) {
  try {
    return await realpath(target);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

export async function acceptanceAsset(path, root, { assetFiles, assetDirs }) {
  const base = await resolved(root);
  if (base === null) return null;
  // The exact-file branch: an allowlist hit names a file, so it gets the same realpath() and the same
  // inside-the-resolved-root requirement as everything below, and only the resolved path is returned.
  const exact = assetFiles.get(path);
  if (exact !== undefined) {
    const exactTarget = await resolved(exact);
    return exactTarget !== null && exactTarget.startsWith(base + sep) ? exactTarget : null;
  }
  // Resolve against the realpath()ed root, so a worktree reached through a symlink compares equal to
  // itself in the prefix tests below.
  const candidate = resolve(base, '.' + path);
  if (!candidate.startsWith(base + sep)) return null;
  const allowedDir = assetDirs
    .map((prefix) => resolve(base, prefix.slice(1)))
    .find((dir) => candidate.startsWith(dir + sep));
  if (allowedDir === undefined) return null;
  const target = await resolved(candidate);
  if (target === null) return null;
  // Root first, then the allowed directory itself realpath()ed: an allowed directory that is ITSELF a
  // link out of the worktree must not widen the allowlist to its resolved contents.
  if (!target.startsWith(base + sep)) return null;
  const confinedDir = await resolved(allowedDir);
  if (confinedDir === null) return null;
  return target.startsWith(confinedDir + sep) ? target : null;
}
