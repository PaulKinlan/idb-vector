// The GitHub Pages site is a static copy of demo/ plus the library modules that demo/app.js
// imports (index.js and utils/*.js). It used to be assembled by the workflow naming the utils/
// modules one file at a time, so a module added under utils/ shipped nowhere: the library import
// broke on the live site and in no local test (idb-vector-crk1). The list is now derived from the
// demo's own import graph, so a new module cannot be forgotten and a module nothing imports is not
// published. tests/unit/site-staging.test.mjs holds the derivation to those two properties.
//
// Resolution is deliberately the browser's rules and nothing more: only relative specifiers are
// followed, resolved against the importing file (every module here spells the .js extension out). A
// bare package specifier is not resolved because the published page has no bundler to resolve it
// either; demo/app.js loads its one external dependency as a blob: URL instead.
import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEMO_DIR = 'demo';
export const DEMO_ENTRY = join(DEMO_DIR, 'app.js');

export function stripComments(src) {
  let result = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') j++;
        j++;
      }
      result += src.slice(i, j + 1);
      i = j + 1;
    } else if (src[i] === '/' && src[i + 1] === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
      result += ' ';
      i = j;
    } else if (src[i] === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < src.length - 1 && !(src[j] === '*' && src[j + 1] === '/')) j++;
      result += ' ';
      i = j + 2;
    } else {
      result += src[i];
      i++;
    }
  }
  return result;
}

// `import … from 'x'`, `export … from 'x'`, `import 'x'` and `import('x')`. A dynamic import with a
// computed argument (app.js passes a blob: URL) has no quoted specifier and is not followed.
// Comments are stripped before matching so comment-separated imports are followed, while strings
// are preserved so prose inside strings does not look like imports.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g;

function specifiersIn(file) {
  const content = stripComments(readFileSync(file, 'utf8'));
  return [...content.matchAll(SPECIFIER)]
    .map(match => match[1])
    .filter(specifier => specifier.startsWith('./') || specifier.startsWith('../'));
}

// Every module reachable from `entry` through relative imports, entry included.
export function moduleClosure(entry, root = process.cwd()) {
  const seen = new Set();
  const queue = [resolve(root, entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersIn(file)) {
      const target = resolve(dirname(file), specifier);
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new Error(`${relative(root, file)} imports '${specifier}', which does not exist`);
      }
      queue.push(target);
    }
  }
  return [...seen];
}

// Copies demo/ recursively plus every imported module that lives outside demo/. Returns the staged
// module paths (repo-relative, sorted) so a caller can report exactly what shipped.
export function stageSite(outDir, { root = process.cwd() } = {}) {
  const demoRoot = join(root, DEMO_DIR);
  cpSync(demoRoot, join(outDir, DEMO_DIR), { recursive: true });
  const outside = moduleClosure(DEMO_ENTRY, root).filter(file => relative(demoRoot, file).startsWith('..'));
  for (const file of outside) {
    const destination = join(outDir, relative(root, file));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(file, destination);
  }
  return outside.map(file => relative(root, file).split(sep).join('/')).sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] ?? 'site';
  mkdirSync(out, { recursive: true });
  const staged = stageSite(out);
  console.log(`staged ${DEMO_DIR}/ plus ${staged.length} imported modules: ${staged.join(', ')}`);
}
