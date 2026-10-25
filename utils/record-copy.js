// The write boundary (insert()/update()) rebuilds the persisted record from the caller's own
// enumerable properties. Bracket assignment on a plain {} invokes the inherited '__proto__'
// SETTER: a JSON.parse'd own '__proto__' field is silently dropped and the copy's [[Prototype]]
// becomes the caller's value, which the structured clone then drops — silent data loss on the
// path whose contract is "what was validated is what is persisted" (idb-vector-56b, after
// idb-vector-1d3/t0u/qnh). A null-prototype copy has no inherited setter, so every own field —
// '__proto__' included — is stored as an own data property, and the structured clone keeps own
// data properties regardless of name (deserialization uses CreateDataProperty, never a setter).
export function copyRecordForStore(object, vectorPath, vector) {
  const record = Object.create(null);
  for (const property of Object.keys(object)) {
    if (property !== vectorPath) record[property] = object[property];
  }
  record[vectorPath] = vector;
  return record;
}
