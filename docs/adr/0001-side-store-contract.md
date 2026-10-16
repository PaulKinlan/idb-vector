# ADR 0001: Side-Store Contract for Bounded Exact Rerank

## Context
The `idb-vector` library is adding an opt-in INT8 side-store (`kuc.10`) to allow bounded exact reranking of embeddings. However, multiple review cycles (beads: `fa2`, `abl`, `hdo`, `8bv`, `yoe`, detailed in `reports/side-store-query.md`) have caught structural bugs around identity and revision correctness. When storing compressed embeddings separate from the original records, the connection between the code and its original can easily drift. This ADR mandates a rigid contract for key identity, store-wide revision pinning, eligibility checks, and bounded retrieval to ensure side-store results are strictly equivalent to exact scan results.

## Decision
We establish the following side-store contract:

1. **Key Identity:** The side-store must record and return the exact IndexedDB primary key (`cursor.primaryKey`) that the main store uses. It must never synthesize keys (e.g., array indices) or assume in-line property names like `id`. The results must carry these real primary keys, derived consistently regardless of key kind (in-line key, out-of-line key, `autoIncrement`, string, number, `Date`, array, or custom `keyPath`).
2. **Revision Pinning & Fail-safe:** To detect corpus changes outside the rerank candidates (e.g., a newly inserted record), the contract must define a **store-wide snapshot revision/epoch**, rather than relying solely on per-original revisions. The side-store must record the corpus-wide epoch when built. On query, it must verify this store-wide epoch against the main store before selection.
   - *Fail-safe behavior:* If the store-wide epoch mismatches, is missing, or the main store has no trustworthy corpus-wide revision mechanism, the side-store query must **reject** (throw an error). We explicitly choose rejection over fallback to exact scan because silent fallback hides the performance regression of a stale side-store from the caller.
3. **Predicate/Eligibility:** To prevent late-filter truncation (where valid candidates are dropped because the candidate budget was exhausted by codes that later fail the predicate), arbitrary record predicates are **forbidden** in side-store queries. Instead, callers provide an `eligibleKeys` collection. The side-store applies this `eligibleKeys` intersection **BEFORE** candidate truncation (budget enforcement).
   - *Key Equality:* Because JS `Set.has` uses object identity (failing for `Date` and array keys), `eligibleKeys` must be evaluated using proper IndexedDB key equality (`indexedDB.cmp(a, b) === 0`) or a canonical serialization that preserves IndexedDB equivalence, never naive JS object identity.
4. **Candidate Budget:** The side-store bounded fetch semantics dictate that it ranks the codes and selects at most `candidateBudget` eligible keys. If the eligible set is smaller than the budget, it yields all of them. The fetch is strictly bounded: only the keys within the top `candidateBudget` of the compressed scores are fetched from the main store for exact Float64 reranking.
5. **API Shape:** The side-store is strictly opt-in and caller-owned. It is never built silently, nor used by default. Reranking on the original Float64 embeddings remains the single source of truth for final scores; the INT8 codes are only used to filter down to the `candidateBudget`.

## Consequences
- **Correctness:** Output structurally matches the exact query, with robust store-wide mutation detection.
- **Constraints:** Callers must maintain a corpus-wide epoch. Filtering requires an explicit `eligibleKeys` check using proper IDB equality.
- **Performance:** Bounded fetch is guaranteed, and callers are explicitly notified (via rejection) if the side-store becomes stale, avoiding accidental full scans.

## Invariant List (Test Requirements)
The implementation's test suite must include at least one test for each of the following invariants:
1. **Key Identity (in-line):** Side-store returns exact keys for an in-line keyPath store.
2. **Key Identity (out-of-line):** Side-store returns exact keys for an out-of-line store.
3. **Key Identity (autoIncrement):** Side-store returns exact generated keys for an autoIncrement store.
4. **Key Identity (number/string):** Side-store correctly handles primitive number and string primary keys.
5. **Key Identity (Date/array):** Side-store correctly handles `Date` and array primary keys.
6. **Key Identity (custom keyPath):** Side-store returns exact keys when a custom nested keyPath is used.
7. **Store-wide Revision Pinning (Stale):** An insert/update to the main corpus that advances the store-wide epoch causes a side-store query on the old epoch to reject.
8. **Store-wide Revision Pinning (Unversioned):** `buildSideStore` or query explicitly refuses (rejects) if the main store lacks a trustworthy corpus-wide revision.
9. **Predicate Rejection:** Passing a JS function `predicate` to a side-store query throws an error, enforcing `eligibleKeys`.
10. **Eligibility Equality (Date/array keys):** `eligibleKeys` correctly matches `Date` and array keys using IDB equivalence (`indexedDB.cmp`), ignoring JS object identity.
11. **Eligibility Before Truncation:** `eligibleKeys` correctly filters candidates *before* the `candidateBudget` is enforced, ensuring valid candidates aren't lost to rejected higher-scoring codes.
12. **Candidate Budget Bounds:** Fetch never exceeds `candidateBudget` records from the main store.