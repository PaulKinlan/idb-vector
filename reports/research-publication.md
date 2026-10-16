# Architecture research publication acceptance

## Scope

Generated `research/index.html` from `research/architecture.md` with pinned build-only
`marked` 17.0.4. The resulting document contains its own CSS and no runtime JavaScript,
fonts or external assets. Regenerate with `npm ci && npm run build:research`.
The Pages workflow regenerates and checks the committed output, then stages research
alongside the existing demo and library. No runtime library or demo code changed.

The public Markdown is byte-for-byte the journal research body except for two approved
publication edits: the absolute local baseline path is repository-relative, and the
internal supervisor-coordination appendix is omitted. All other sections, tables,
labels and citations remain intact. The HTML adds a contents list and visibly separate
dated publication notes rather than silently rewriting the research.

Those notes distinguish inference from measurement, keyed IDB access from its cost,
opt-in whitening from defaults, and a constructed post-filter failure from a blanket
library defect. They also cite the later packed-read artifact at immutable commit
`232b95c0215dab48d760bef6c2cf7e88186f4780`: the 31.4/93.6/742.9/8.6 ms medians were
checked against its three raw samples. Corpus, dimensions, precision, browser, CPU,
warm-read conditions and exclusion of top-k are displayed next to the numbers.
Neither the arithmetic microbenchmark nor the cross-source estimate is described as
an end-to-end cached-query result.

## Browser acceptance, 21 September 2026

`npm run test:research -- --links`, actual Chromium 152.0.7977.82 via the repository's
raw-CDP helper, temporary profile and owned ephemeral local HTTP server:

- 66 original citation occurrences preserved in order; all 30 source headings, eight
  tables and 53 evidence-label spans rendered. Contradictions and missing evidence visible.
- All 29 contents anchors clicked with real CDP pointer events; URL fragment and target
  viewport position asserted after each click.
- 1280px desktop and 390px mobile, light and dark: computed theme colours asserted,
  no document-width overflow. Wide tables scroll within their own keyboard-focusable region.
- Demo and Markdown links resolved through the browser with HTTP 200.
- All 49 distinct external targets checked with bounded HTTP requests: 47 returned 200,
  patrickbrosset.com failed once with a transient `fetch failed`, and npm's Vectra page
  returned 403. These are the numbers in the committed receipt (`externalLinks` in
  [research-publication.json](research-publication.json)); an earlier draft of this line
  said "48 returned 200", which its own receipt does not support. An actual Chromium visit
  confirmed the npm response is a security challenge, not a missing citation. The source
  link is preserved and the accessible Vectra docs remain linked. The npm exception is also
  disclosed on the report itself.
- Chromium navigated to VectorSearch.js, MeMemo's arXiv HTML and the immutable packed-read
  evidence on GitHub; actual page titles and content lengths recorded.

Committed machine-readable receipt: [research-publication.json](research-publication.json).
Screenshots were captured (desktop/mobile, both themes, source-anchor landing) in the
external `cap-evidence/idb-research-pages/` evidence directory; no PNG was read or visually
reviewed by this author.

A citation-preservation mutation (replace the first MeMemo target with
`https://example.invalid/mutated-citation` in generated HTML) made the browser check exit 1
at `every citation target preserved`. The generator restored the output afterward.
Two successive generations produced identical SHA-256. `git diff --check` and the existing
`npm test` browser behaviour suite passed.

`npm audit` reports nine existing serve-tree advisories (six high, one moderate, two low),
none attributed to marked; dependency remediation is outside this publication change.

## Public deployment verification, 15 October 2026

The report landed on `main` (`ec1a9f6`) and Pages deployed it. The public route was then
checked against the served bytes with the same checker, run from this repository:

```sh
RESEARCH_URL=https://paulkinlan.github.io/idb-vector/research/ \
  RESEARCH_EVIDENCE=.cache/research-live npm run test:research -- --links   # exit 0
```

Actual Chromium 155.0.8059.39 (a newer build than the 152.0.7977.82 of the local run) over
raw CDP, no local server involved for the page under test:

- **The served bytes are the committed bytes.** `curl` SHA-256 of the live
  `/research/index.html` is `8360a1f6ac064873786bea14986348f297ad0cb6d67e27c6420b83b0368d0ea5`
  and of the live `/research/architecture.md` is
  `ee77a72e93509d78afde0108c246d05015dde531ec6aee1ba9ab569ebafd4f9a`; both equal the
  committed files. The deployed page is not a stale or divergent build.
- 66 citation occurrences preserved in order, 30 headings, eight tables and 53
  evidence-label spans present on the live document.
- All 29 contents anchors clicked with real CDP pointer events; fragment and target
  viewport position asserted after each click.
- 1280px and 390px, light and dark: theme colours asserted, no document-width overflow.
- Live same-origin links resolved: `/demo/` and `/research/architecture.md` both 200.
- 49 distinct external targets: 47 returned 200, `arxiv.org/pdf/1702.01417.pdf` returned
  301 (the checker deliberately does not follow publisher redirects), npm's Vectra page
  returned 403. The transient `patrickbrosset.com` fetch failure from the local run did
  not reproduce; it returned 200. No citation target was removed or rewritten.
- Chromium visited VectorSearch.js, MeMemo's arXiv HTML and the immutable packed-read
  evidence at `232b95c`; page titles and content lengths recorded.

The screenshots for this phase are in `.cache/research-live/` (gitignored, as the earlier
local set was): `1280-light`, `1280-dark`, `390-light`, `390-dark` and `anchor-sources`.
They were captured but not read by the author of this receipt; the assertions above are
programmatic. The machine-readable receipt for this phase is the `live` key in
[research-publication.json](research-publication.json).

The existing `/demo/` staging remains intact and serving.
