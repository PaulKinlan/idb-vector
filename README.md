# Vector IDB

A simple IDB vector store.

```JavaScript
<script type="module">
  import { VectorDB } from "idb-vector";

  const db = new VectorDB({
    vectorPath: "embedding"
  });

  await db.insert({ embedding: [1, 2, 3], "text": "ASDASINDASDASZd" });
  await db.insert({ embedding: [2, 3, 4], "text": "GTFSDGRG" });
  await db.insert({ embedding: [73, -213, 3], "text": "hYTRTERFR" });

  // Query returns a list ordered by the entries closest to the vector (cosine similarity)
  console.log(await db.query([1, 2, 3], { limit: 20 }));
</script>
```
