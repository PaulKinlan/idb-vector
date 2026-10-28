import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestPathname } from './request-pathname.mjs';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);

// The allow-list below is the first line of defence; this is the second. A name that survives the
// pattern is still only a string, and `resolve()` on it can land anywhere: an absolute name such as
// the `/demo/app.js` produced by `/idb-vector//demo/app.js` resolves against the filesystem root, and
// a `..` that the pattern later learns to accept would climb out. So normalise the candidate, compare
// it against the resolved server root, and `realpath()` it so a symlink inside the tree cannot point
// the read back outside. null means "refuse": the caller answers 403, distinct from the 404 the
// allow-list produces, because the two failures mean different things (idb-vector-r5wg).
// Empty or whitespace-containing names are refused immediately.
// A name inside the root that simply does not exist stays inside by construction and is returned as
// is, so readFile still reports it as 404 rather than as a confinement failure.
export async function confinedFile(name, serverRoot = rootPath) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed !== name || /\s/.test(name)) return null;
  try {
    const base = await realpath(serverRoot);
    const candidate = resolve(base, name);
    if (!candidate.startsWith(base + sep)) return null;
    const target = await realpath(candidate).catch(() => candidate);
    return target.startsWith(base + sep) ? target : null;
  } catch {
    return null;
  }
}

export async function serve() {
  const server = createServer(async (req, res) => {
    const path = requestPathname(req);
    if (path === null) { res.writeHead(400).end(); return; }
    // Exercise the same repository subpath used by GitHub Pages.
    const name = path.replace(/^\/idb-vector\//, '');
    // GitHub Pages serves index.html for a trailing-slash directory URL, so resolve the directory
    // BEFORE validating: validating the raw name rejected the bare 'demo/' root, which is exactly
    // where the lab's own "../" back-link points, while /demo/compute/ happened to pass.
    const file = name.endsWith('/') ? `${name}index.html` : name;
    if (path === name || name.includes('..') || !/^(demo\/[\w./-]+|index\.js|utils\/(?:sortedarray|geometry|packed-snapshot|side-store|options|record-copy)\.js)$/.test(file)) {
      res.writeHead(404).end(); return;
    }
    const target = await confinedFile(file);
    if (target === null) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(target);
      res.setHeader('Content-Type', ({ js: 'text/javascript', html: 'text/html', css: 'text/css', json: 'application/json', wasm: 'application/wasm' })[file.split('.').pop()] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/idb-vector/demo/index.html` };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log((await serve()).url);
