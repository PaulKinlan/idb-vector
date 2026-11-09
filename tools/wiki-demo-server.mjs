import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestPathname } from './request-pathname.mjs';
import { hostAllowed } from './request-host.mjs';
import { refuse } from './refusal.mjs';
import { answerFault } from './server-fault.mjs';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);

// The allow-list below is the first line of defence; this is the second. A name that survives the
// pattern is still only a string, and `resolve()` on it can land anywhere: an absolute name such as
// the `/demo/app.js` produced by `/idb-vector//demo/app.js` resolves against the filesystem root, and
// a `..` that the pattern later learns to accept would climb out. So normalise the candidate, compare
// it against the resolved server root, and `realpath()` it so a symlink inside the tree cannot point
// the read back outside. null means "refuse": the caller answers the shared refusal status (404,
// tools/refusal.mjs) - the same answer the allow-list below gives, because "not an allowed asset" is
// one meaning (idb-vector-r5wg, idb-vector-zs1u).
// Empty or whitespace-containing names are refused immediately.
// realpath() is the only thing that can tell a link from its target, so its answer is the answer: a
// candidate that cannot be resolved is refused, never returned unresolved for readFile to follow. The
// unresolved fallback this had let a DANGLING link (demo/x.html -> /tmp/outside.html, target not
// created yet) through: 404 while the target was absent, and a served file outside the root as soon as
// anything created it, one await before the read (idb-vector-4c06). A name inside the root that simply
// does not exist is unresolvable too, so it is refused here rather than reaching readFile;
// tools/research-asset-allowlist.mjs applies the same rule to the same shapes, and
// tests/unit/asset-confinement-parity.test.mjs asserts that the two answer alike.
//
// null has to keep ONE meaning - "refuse" - so a realpath() that FAILS is not the same answer as a
// realpath() that succeeds and lands outside the root. ENOENT and ENOTDIR are still refusals: "there is
// no such name under the root" is a decision about the name. EACCES, EIO and ELOOP are the filesystem
// failing to answer, and reporting them as null put a server fault in "the path does not exist"
// clothing - the masking idb-vector-7g2x removed one layer down, where a failed readFile() no longer
// answers the refusal (idb-vector-bc9t). These throw instead, and the handler answers 500; rethrowing
// rather than returning a distinct sentinel keeps the return value single-typed, because every caller
// and every test above reads this function as "a path, or null for a refusal".
export async function confinedFile(name, serverRoot = rootPath) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed !== name || /\s/.test(name)) return null;
  // A root that cannot be resolved is a configuration error: refuse rather than compare lexically.
  const base = await resolved(serverRoot);
  if (base === null) return null;
  const candidate = resolve(base, name);
  if (!candidate.startsWith(base + sep)) return null;
  const target = await resolved(candidate);
  return target !== null && target.startsWith(base + sep) ? target : null;
}

// The two error codes that mean "no such name": ENOENT for an absent target, ENOTDIR for a path whose
// component is a file. Everything else a realpath() can raise is the filesystem failing to answer.
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

// serverRoot is a parameter for the same reason confinedFile() takes one: a fault in the confinement
// layer (a realpath() that fails rather than decides) can only be driven against a tree the caller
// owns, and it must be answered by this handler, not by a helper called from a test
// (tests/unit/wiki-demo-server-faults.test.mjs).
export async function serve(serverRoot = rootPath) {
  const server = createServer(async (req, res) => {
    // A loopback bind is not a browser-origin boundary on its own: a rebound page reaches this port
    // with its own hostname as Host (idb-vector-2703). Rules and rationale in tools/request-host.mjs;
    // the answer is the shared refusal (tools/refusal.mjs), before anything else looks at the request.
    if (!hostAllowed(req)) { refuse(res); return; }
    const path = requestPathname(req);
    if (path === null) { res.writeHead(400).end(); return; }
    // Exercise the same repository subpath used by GitHub Pages.
    const name = path.replace(/^\/idb-vector\//, '');
    // GitHub Pages serves index.html for a trailing-slash directory URL, so resolve the directory
    // BEFORE validating: validating the raw name rejected the bare 'demo/' root, which is exactly
    // where the lab's own "../" back-link points, while /demo/compute/ happened to pass.
    const file = name.endsWith('/') ? `${name}index.html` : name;
    // Admission and the read are two events, but a fault in either one is the same server fault: a
    // confinement helper that cannot answer (it throws rather than refusing, see confinedFile()) and a
    // read that fails after admission are both 500, never the refusal the explicit returns below send.
    try {
      if (path === name || name.includes('..') || !/^(demo\/[\w./-]+|index\.js|utils\/(?:sortedarray|geometry|packed-snapshot|side-store|options|record-copy)\.js)$/.test(file)) {
        refuse(res); return;
      }
      const target = await confinedFile(file, serverRoot);
      // Refused: tools/refusal.mjs answers the same 404 both the allow-list above and
      // the research acceptance driver (tests/research.mjs) answer for the same refusal (idb-vector-zs1u, idb-vector-sd71).
      if (target === null) { refuse(res); return; }
      // The read is where the two meanings split, and this server was the one that merged them
      // (idb-vector-7g2x): everything above answers a path that is NOT an allowed asset, while a read
      // that fails on a target confinedFile() already admitted and realpath()ed - EACCES, fd exhaustion,
      // a delete between the realpath() and the read, a directory named as a file (EISDIR) - is a server
      // fault. Answering the refusal here made a failed read look like a correct refusal, in the one
      // server a human actually runs. tools/demo-server.mjs ('Could not read demo file'),
      // tests/real-vectors.mjs ('Dataset unavailable') and tests/research.mjs ('Acceptance server
      // error') all answer 500 for this event; tests/research.mjs records why (idb-vector-7iu): a 404
      // must mean "not an allowed asset", never "this handler crashed". None of the four logs it to
      // stderr, so this one does not either - the 500 with its body is the loud answer.
      const body = await readFile(target);
      res.setHeader('Content-Type', ({ js: 'text/javascript', html: 'text/html', css: 'text/css', json: 'application/json', wasm: 'application/wasm' })[file.split('.').pop()] || 'application/octet-stream');
      res.end(body);
    } catch { answerFault(res, 'Could not read demo file'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/idb-vector/demo/index.html` };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log((await serve()).url);
