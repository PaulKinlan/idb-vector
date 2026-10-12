# ADR 0001: Side-Store Contract for Bounded Exact Rerank

## Context
The `idb-vector` library is adding an opt-in INT8 side-store (`kuc.10`) to allow bounded exact reranking of embeddings, reducing memory overhead and scan times. However, multiple review cycles (beads: `fa2`, `abl`, `hdo`, `8bv`, `yoe`) have repeatedly caught structural bugs around identity and revision correctness. When storing compressed embeddings separate from the original records, the connection between the code and its original can easily drift or fail on schema variations (custom keypaths, out-of-line keys). This ADR mandates a rigid contract for key identity, revision pinning, eligibility, and bounded retrieval to ensure side-store results are strictly equivalent to exact scan results.

## Decision
We establish the following side-store contract:

1. **Key Identity:** The side-store must record and return the *exact* IndexedDB primary key (`cursor.primaryKey`) that the main store uses. It must never synthesize keys (e.g., array indices) or assume in-line property names like `id` when the store uses out-of-line keys or a custom `keyPath`. The returned result objects must carry these real primary keys, matching the shape returned by an exact scan.
2. **Revision Pinning & Fail-safe:** A side-store must be built with a specific `revision` identifier. When reranking, the process must fetch the original records using the side-store keys and strictly verify that each original record possesses a `revision` property matching the pinned revision.
   - *Fail-safe behavior:* If an original record is missing, has no revision, or its revision mismatches, the query must immediately **fall back to an exact scan** (if `fallback: true` is configured) or **reject the query** with an error. It must never silently drop the record and return a truncated result, nor silently score a stale record. Building the side-store must throw if any original record lacks the required revision property.
3. **Predicate/Eligibility:** To prevent late-filter truncation (where valid candidates are dropped because the budget was exhausted by candidates that later fail the predicate), arbitrary record predicates are **forbidden** in side-store queries. Instead, callers must provide a pre-filtered Set or Array of `eligibleKeys`. The side-store scan must intersect candidates against `eligibleKeys` *before* maintaining the candidate budget.
4. **Candidate Budget:** The side-store ranks compressed INT8 codes and retains at most `candidateBudget` eligible keys. If the total number of eligible records is smaller than or equal to `candidateBudget`, all such records are fetched for Float64 reranking. Under no circumstances should the side-store return more than `candidateBudget` records to the reranker.
5. **API Shape:** The side-store is strictly opt-in and caller-owned. It is never built silently, nor used by default. Reranking on the original Float64 embeddings remains the single source of truth for final scores; the INT8 codes are only used to select the `candidateBudget` keys.

## Consequences
- **Correctness:** We eliminate silently stale or incorrectly keyed results. The output of a side-store query will structurally match the exact query.
- **Constraints:** Callers are forced to use `eligibleKeys` instead of JS predicates if they want side-store acceleration with filtering.
- **Data Model:** Records in the vector store must have a `revision` property if the side-store is used.
- **Performance:** For out-of-sync side-stores, falling back to an exact scan incurs the full scan cost, strongly incentivizing callers to rebuild the side-store when the main store changes.

## Invariant List (Test Requirements)
The implementation's test suite must include at least one test for each of the following invariants:
1. **Key Identity:** A side-store query on an out-of-line store returns the exact out-of-line primary keys (not indices or `record.id`).
2. **Revision Pinning (Stale):** An original record updated to a new revision is rejected during reranking under the old pinned revision.
3. **Revision Pinning (Unversioned):** `buildSideStore` throws if an original record lacks the revision property.
4. **Revision Pinning (Fail-safe):** A missing or mismatched original record triggers a fallback to exact scan (if enabled) or throws an error.
5. **Predicate Rejection:** Passing a JS function `predicate` to a side-store query throws a `TypeError`.
6. **Eligibility Before Truncation:** Passing `eligibleKeys` correctly filters candidates *before* the `candidateBudget` is enforced.
