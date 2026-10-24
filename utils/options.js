// The option contract every entry point validates against, in one place (idb-vector-cej, invariant I4:
// "every entry point must agree on what it accepts").
//
// An option a method does not honour used to be silently DROPPED: `query(vector, { predicate })` then
// returned an unfiltered ranking that looked filtered, and a snapshot could be created or queried with
// a key nobody applied. The two snapshot entry points diverged worst — the writer took only `maxBytes`,
// the reader took only `limit` and did not validate it, so `limit: NaN` disabled SortedArray's
// truncation test (`length > maxLength` is false when maxLength is NaN) and a negative limit inverted
// `slice(0, limit)`. Both sides now read the same lists below and refuse anything else with a message
// that names the options that do exist.

export function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `an Array of length ${value.length}`;
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return String(value);
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Missing options mean `limit` 10, never "no limit".
export const DEFAULT_LIMIT = 10;

export function assertLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive integer; got ${describe(limit)}`);
  }
  return limit;
}

// --- accepted option keys, per entry point -----------------------------------------------------
// VectorDB.query()/queryCandidates(): a query option that is silently ignored is a filter the caller
// believes they applied, so the candidate-only keys get a pointer to the method that honours them.
export const CANDIDATE_OPTION_KEYS = ["limit", "threshold", "index", "range", "predicate"];
export const QUERY_OPTION_KEYS = ["limit", "threshold"];
// Snapshots: the writer's memory budget, and the reader's ranked top-k. They are deliberately NOT the
// same list, because the two sides do different work; what they must share is the refusal, so neither
// silently drops a key that belongs to the other.
export const SNAPSHOT_OPTION_KEYS = ["maxBytes"];
export const SNAPSHOT_QUERY_OPTION_KEYS = ["limit"];
// The opt-in side store (ADR 0001).
export const SIDE_STORE_BUILD_OPTION_KEYS = ["sideStore", "key", "epoch", "getEpoch", "revision"];
export const SIDE_STORE_QUERY_OPTION_KEYS = ["sideStore", "key", "epoch", "getEpoch", "candidateBudget", "limit", "threshold", "predicate", "eligibleKeys", "codeRecord", "revision"];
export const SIDE_STORE_FACTORY_OPTION_KEYS = ["sideStore", "key", "epoch", "revision", "candidateBudget", "getEpoch"];

/**
 * Refuse an options value that this entry point does not honour.
 *
 * `absent: "allow"` keeps the older signature where the whole options argument is optional; the default
 * rejects a missing options object so a caller who forgot it hears about it instead of destructuring
 * `undefined`.
 *
 * `hint` (string or `(key) => string`) is appended after the supported list, so the message can point at
 * the method or the argument that does honour the key.
 *
 * `lead` exists because these messages are part of this library's tested contract: it lets a call site
 * keep its established wording ("supported options are ...") while sharing the check.
 */
export function assertOptionKeys(method, options, allowed, { hint = "", lead = null, absent = "reject", example = "" } = {}) {
  if (options === undefined || options === null) {
    if (absent === "allow") return;
    throw new TypeError(`${method}() options must be an object${example ? ` such as ${example}` : ""}; got ${describe(options)}`);
  }
  if (!isRecord(options)) {
    throw new TypeError(`${method}() options must be an object${example ? ` such as ${example}` : ""}; got ${describe(options)}`);
  }
  for (const key of Object.keys(options)) {
    if (allowed.includes(key)) continue;
    const extra = typeof hint === "function" ? hint(key) : hint;
    throw new TypeError(`${method}() option ${describe(key)} is not supported; ${lead ?? `${method}() options are`} ${allowed.join(", ")}.${extra ? ` ${extra}` : ""}`);
  }
}
