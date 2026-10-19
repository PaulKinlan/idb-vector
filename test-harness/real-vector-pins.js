// The trust root for the real-vector research harness.
//
// `.cache/real-vectors/<corpus>/manifest.json` is DATA. tools/prepare-real-vectors.py writes it next
// to the corpus, and the harness serves it from the same directory as vectors.f32/cells.u32, so a
// checksum compared against that manifest attests to nothing: mutate the corpus, update the manifest
// beside it, and every check still passes while the published recall numbers change quietly.
//
// The pin below is the trust root instead. It lives in the repository, the browser harness verifies
// the served manifest against it before reading any vector, and repinning is a commit reviewed like
// any other — the same anchoring as demo/integrity.js's MANIFEST_SHA256 for demo/assets.json.
//
// A pin is the SHA-256 of the canonical view of everything a measurement trusts from the manifest:
// identity, file digests and byte counts, the 40 held-out queries, the ground truth those queries are
// scored against, and the IVF centroids. Prepare-time telemetry (preparedAt, prepareTotalMs,
// trainingMs) is deliberately outside the view, so re-preparing identical content still matches —
// tools/prepare-real-vectors.py seeds its IVF sampling, so the content is reproducible.
//
// The published evidence reports (reports/real-*.json) embed the same manifests. The fast-tier test
// tests/unit/real-vector-pins.test.mjs keeps these pins and those reports in agreement, so a corpus
// cannot be repinned without published evidence behind it.

// The exact fields the harness's numbers depend on, in a fixed order: JSON.stringify preserves
// insertion order, so the digest is stable across runs and machines.
export const TRUSTED_FILES = ['vectors.f32', 'cells.u32'];

export function trustedView(manifest) {
  const file = name => {
    const entry = manifest?.files?.[name];
    return entry === undefined ? null : { sha256: entry.sha256 ?? null, bytes: entry.bytes ?? null };
  };
  return {
    name: manifest?.name ?? null,
    count: manifest?.count ?? null,
    dimensions: manifest?.dimensions ?? null,
    metric: manifest?.metric ?? null,
    files: Object.fromEntries(TRUSTED_FILES.map(name => [name, file(name)])),
    queries: manifest?.queries ?? null,
    truth: Array.isArray(manifest?.truth)
      ? manifest.truth.map(row => ({
          ids: row?.ids ?? null,
          scores: row?.scores ?? null,
          acceptableIds: row?.acceptableIds ?? null,
        }))
      : null,
    centroids: manifest?.ivf?.centroids ?? null,
  };
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function trustedDigest(manifest) {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(trustedView(manifest))));
}

// Digests of the corpus manifests published in reports/real-glove-2026-10-15.json and
// reports/real-wiki-2026-10-15.json. tests/unit/real-vector-pins.test.mjs recomputes every one of
// them from those reports, and the harness refuses any corpus that is not listed here.
export const REAL_VECTOR_PINS = {
  'glove25-10000': {
    count: 10000, dimensions: 25,
    // reports/real-glove-2026-10-15.json
    sha256: 'ceb5b617969ef74d8e680ef117a8a8189abb997e9250fcb5508fa49b12b62f88',
  },
  'glove25-100000': {
    count: 100000, dimensions: 25,
    // reports/real-glove-2026-10-15.json
    sha256: 'd2f430db470c8aa01608d0c8bd8f5969d3e5a120f8755bf8d904afd04caf686b',
  },
  'glove25-1183514': {
    count: 1183514, dimensions: 25,
    // reports/real-glove-2026-10-15.json
    sha256: 'a2b6b58647aca890047d533c8ee5ea2a34a3e228ef0de497a276ad0985c7eb19',
  },
  'wiki-api-10000': {
    count: 10000, dimensions: 256,
    // reports/real-wiki-2026-10-15.json
    sha256: '75535cec1be8ae980ee001df91162cf8ec55658b5f36a9ad98633f85e0a0fe96',
  },
};

export function pinFor(corpus, pins = REAL_VECTOR_PINS) {
  if (pins === null || typeof pins !== 'object' || Object.hasOwn(pins, corpus) === false) {
    throw new Error(
      `Corpus ${JSON.stringify(corpus)} is not pinned, so its measurement cannot be attested: refusing to read it. ` +
        'Repinning is a repository commit to test-harness/real-vector-pins.js backed by published evidence (reports/real-*.json).'
    );
  }
  return pins[corpus];
}

// Refuse a served manifest that disagrees with the pin, before any vector is read. Every trusted
// field — the file digests, the held-out queries, the ground truth and the centroids — is covered by
// the digest, so a corpus mutated together with its manifest fails here rather than passing.
export async function verifyCorpus(corpus, manifest, pins = REAL_VECTOR_PINS) {
  const pin = pinFor(corpus, pins);
  if (manifest?.name !== corpus) {
    throw new Error(`Corpus manifest names ${JSON.stringify(manifest?.name)}, not ${JSON.stringify(corpus)}; refusing to measure it.`);
  }
  if (manifest?.count !== pin.count || manifest?.dimensions !== pin.dimensions) {
    throw new Error(
      `Corpus ${corpus} is ${manifest?.count} × ${manifest?.dimensions} but its pin is ${pin.count} × ${pin.dimensions}: refusing to measure it.`
    );
  }
  const digest = await trustedDigest(manifest);
  if (digest !== pin.sha256) {
    throw new Error(
      `Corpus ${corpus} does not match its pin (${digest} vs ${pin.sha256}): the manifest, queries, ground truth, centroids or file digests served beside the data differ from the pinned corpus. ` +
        'A manifest cannot attest to itself — repinning is a repository commit to test-harness/real-vector-pins.js.'
    );
  }
  return pin;
}
