import assert from 'node:assert/strict';
import { permittedCitation } from './lib/research-link-policy.mjs';

for (const url of ['https://github.com/example', 'https://arxiv.org/html/2407.01972',
  'https://www.vldb.org/pvldb/']) assert.equal(permittedCitation(url), true, url);
for (const url of ['http://github.com/example', 'https://127.0.0.1/private',
  'https://169.254.169.254/latest/meta-data', 'https://github.com.evil.test/',
  'https://user:pass@github.com/', 'https://github.com:8443/',
  'https://[::1]/', 'not a URL']) assert.equal(permittedCitation(url), false, url);
console.log('Citation URL policy accepts pinned HTTPS publishers only');
