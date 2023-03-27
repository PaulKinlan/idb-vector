# Vector IDB

A simple IDB vector store.

```
<script type="module">
  import { create, insert, query } from "./script.js";

  await insert({ embedding: [1, 2, 3], "text": "ASDASINDASDASZd" }, "embedding");
  await insert({ embedding: [2, 3, 4], "text": "GTFSDGRG" }, "embedding");
  await insert({ embedding: [73, -213, 3], "text": "hYTRTERFR" }, "embedding");

  console.log(await query([1, 2, 3], "embedding", 20));
</script>
```