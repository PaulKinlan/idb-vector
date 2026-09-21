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
- All 49 distinct external targets checked with bounded HTTP requests: 48 returned 200;
  npm's Vectra page returned 403. An actual Chromium visit confirmed a security challenge,
  not a missing citation. The source link is preserved and the accessible Vectra docs
  remain linked. This exception is also disclosed on the report itself.
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

## Deployment status

This receipt verifies the branch on an owned local server, **not the public `/research/`
route**. Independent review and main integration are required before Pages deploys.
The existing `/demo/` staging remains intact. After deployment run:

```sh
RESEARCH_URL=https://paulkinlan.github.io/idb-vector/research/ \
  RESEARCH_EVIDENCE=.cache/research-live npm run test:research -- --links
```

Do not describe the proposed public research URL as verified until that check runs.
