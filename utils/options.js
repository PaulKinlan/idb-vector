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
 *
 * The keys checked are the whole prototype chain, not just the own ones (idb-vector-v743). Call sites
 * read their options by property access (`options.limit`), which sees an inherited key, so a list that
 * inspected own keys only disagreed with the code it guards: `query(vector, Object.create({ predicate }))`
 * passed the check and returned the unfiltered ranking that looked filtered — the closed 5a8 regression,
 * and the I4 invariant at the top of this file. An inherited key now reaches the same refusal (naming
 * that it was inherited), and an inherited key that IS on the list stays accepted, because property
 * access really does read it and the method really does honour it. Enumerability is the same boundary the
 * allow-list always used (`Object.keys` is own + enumerable, now taken up the chain), so non-enumerable
 * prototype members — class methods — are still not options: nobody supplies them as one.
 */
export function assertOptionKeys(method, options, allowed, { hint = "", lead = null, absent = "reject", example = "" } = {}) {
  if (options === undefined || options === null) {
    if (absent === "allow") return;
    throw new TypeError(`${method}() options must be an object${example ? ` such as ${example}` : ""}; got ${describe(options)}`);
  }
  if (!isRecord(options)) {
    throw new TypeError(`${method}() options must be an object${example ? ` such as ${example}` : ""}; got ${describe(options)}`);
  }
  // An own '__proto__' key (JSON.parse produces one) names the prototype accessor, not an option, so it is
  // refused before the list is consulted — the same refusal convention the write boundary and vectorPath
  // already use. Nothing here writes onto `options`, so no allow-list entry can turn this key into a
  // prototype mutation either way; the hasOwn form also catches a non-enumerable one that for...in skips.
  if (Object.hasOwn(options, "__proto__")) {
    throw new TypeError(`${method}() options must not carry a '__proto__' key: it names the prototype accessor rather than an option. Use a normal option name (${allowed.join(", ")}).`);
  }
  for (const key in options) {
    if (allowed.includes(key)) continue;
    const origin = Object.hasOwn(options, key) ? "" : " (the key is inherited through the options object's prototype)";
    const extra = typeof hint === "function" ? hint(key) : hint;
    throw new TypeError(`${method}() option ${describe(key)} is not supported${origin}; ${lead ?? `${method}() options are`} ${allowed.join(", ")}.${extra ? ` ${extra}` : ""}`);
  }
}
