import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const files = new Set(['index.js', 'utils/sortedarray.js', 'test-harness/index.html',
  'test-harness/demo.js', 'test-harness/experiment.js', 'reports/browser-analysis.md']);
export async function serve() {
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'test-harness/index.html';
    if (!files.has(name)) { res.writeHead(404).end('Not found'); return; }
    try {
      const content = await readFile(new URL(name, root));
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.html') ? 'text/html' : 'text/plain');
      res.setHeader('Cache-Control', 'no-store');
      // Relative module imports require the real directory URL.
      if (!new URL(req.url, 'http://localhost').pathname.slice(1)) {
        res.writeHead(302, { Location: '/test-harness/index.html' }).end(); return;
      }
      res.end(content);
    } catch { res.writeHead(500).end('Could not read demo file'); }
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/test-harness/index.html` };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve();
  console.log(`Vector IDB demo: ${url}`);
}
