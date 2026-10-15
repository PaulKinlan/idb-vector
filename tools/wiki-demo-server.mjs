import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
export async function serve() {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    // Exercise the same repository subpath used by GitHub Pages.
    const name = path.replace(/^\/idb-vector\//, '');
    // GitHub Pages serves index.html for a trailing-slash directory URL, so resolve the directory
    // BEFORE validating: validating the raw name rejected the bare 'demo/' root, which is exactly
    // where the lab's own "../" back-link points, while /demo/compute/ happened to pass.
    const file = name.endsWith('/') ? `${name}index.html` : name;
    if (path === name || name.includes('..') || !/^(demo\/[\w./-]+|index\.js|utils\/(?:sortedarray|geometry|packed-snapshot)\.js)$/.test(file)) {
      res.writeHead(404).end(); return;
    }
    try {
      const body = await readFile(new URL(file, root));
      res.setHeader('Content-Type', ({ js: 'text/javascript', html: 'text/html', css: 'text/css', json: 'application/json', wasm: 'application/wasm' })[file.split('.').pop()] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/idb-vector/demo/index.html` };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log((await serve()).url);
