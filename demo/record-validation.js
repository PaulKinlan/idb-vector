// A restored passage is data the page did not just write: IndexedDB survives across demo versions, is
// writable by any script on the same origin, and a failed write leaves whatever it managed to commit.
// The demo used to check only the vector of a stored record and then render its title, text, pageid
// and revision straight into headings and hrefs, so one bad record could put arbitrary text or a
// foreign link into the page (idb-vector-4skw).
//
// Every field the panel renders or turns into a link is checked here before use, and a record that
// fails is dropped with a message instead of being rendered with holes in it. demo/app.js's restore
// probe asks validateStoredRecord(), the bigger question of whether a record is usable by the library
// at all, and validateStoredMeta() about the `loaded` record whose timings it draws; demo/results.js
// asks validateRecord(), whether a result may be drawn. `isRecord` is the library's own definition of
// "a record", so both sides agree with what idb-vector stores.
import { isRecord } from '../utils/options.js';

// Bounds, not schema: the corpus passages are at most ~600 characters of text and Wikipedia titles
// are under 255 bytes, so these leave real data alone and refuse a record sized to freeze the panel.
export const TITLE_MAX = 300;
export const TEXT_MAX = 2000;
export const LINK_MAX = 2048;
export const EMBEDDING_DIMENSIONS = 384;

// The corpus is one publisher, so a link field is https on that host or it is not a link this page
// has any business following. results.js builds the passage and history hrefs from pageid and
// revision instead, so the record's own `url` is not rendered today; it is refused all the same,
// because a link field is a link field whether or not this version of the page happens to show it.
const PERMITTED_LINK_HOST = 'en.wikipedia.org';

export function permittedLink(value) {
  if (typeof value !== 'string' || value.length > LINK_MAX) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  // `host` carries the port, so a non-default port fails the host check; embedded credentials fail
  // their own test rather than being sent to a publisher on a reader's behalf.
  return url.protocol === 'https:' && url.host === PERMITTED_LINK_HOST && url.username === '' && url.password === '';
}

// Returns null when the record may be rendered, otherwise a short reason naming the first field that
// cannot be. Reasons are the page's own words (never the record's), so they are safe to show.
export function validateRecord(record) {
  if (!isRecord(record)) return 'the record is not an object';
  const { title, text, pageid, revision, url } = record;
  if (typeof title !== 'string' || title.trim() === '') return 'title is missing';
  if (title.length > TITLE_MAX) return `title is longer than ${TITLE_MAX} characters`;
  if (typeof text !== 'string') return 'text is missing';
  if (text.length > TEXT_MAX) return `text is longer than ${TEXT_MAX} characters`;
  for (const [field, value] of [['pageid', pageid], ['revision', revision]]) {
    if (!Number.isSafeInteger(value) || value <= 0) return `${field} is not a positive integer`;
  }
  if (url !== undefined && !permittedLink(url)) return 'url is not an https en.wikipedia.org link';
  return null;
}

// The restore probe's other input: loadTiming() draws count and three durations from the stored
// `loaded` record and calls .toFixed on them, so a store written by another connection could make the
// restore probe throw while it is rendering, leaving the panel with half a line and no verdict.
export function validateStoredMeta(meta) {
  if (!isRecord(meta)) return 'the stored metadata is not an object';
  if (!Number.isSafeInteger(meta.count) || meta.count < 0) return 'count in the stored metadata is not a count';
  for (const field of ['totalMs', 'setupMs', 'writeMs']) {
    if (!Number.isFinite(meta[field]) || meta[field] < 0) return `${field} in the stored metadata is not a duration`;
  }
  if (typeof meta.browser !== 'string' || meta.browser.length > TEXT_MAX) return 'browser in the stored metadata is not a label';
  return null;
}

// The restore probe's question, which is the render check plus the vector search needs. Querying
// already refuses an unscoreable stored vector with its own message (index.js storedVectorError), so
// the panel does not pay for this check again.
export function validateStoredRecord(record) {
  const embedding = isRecord(record) ? record.embedding : undefined;
  // Array.from, like the check this replaces: `every` skips holes, and a sparse vector is not a vector.
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) return `embedding is not ${EMBEDDING_DIMENSIONS} numbers`;
  if (!Array.from(embedding).every(Number.isFinite)) return 'embedding has a coordinate that is not a number';
  return validateRecord(record);
}
