# Vector IDB

A simple IDB vector store.

```JavaScript
 <script type="module">
  import { create, insert, query } from "../index.js";

  const path =  { vectorPath: "embedding" };

  await insert({ embedding: [1, 2, 3], "text": "ASDASINDASDASZd" }, path);
  await insert({ embedding: [2, 3, 4], "text": "GTFSDGRG" }, path);
  await insert({ embedding: [73, -213, 3], "text": "hYTRTERFR" }, path);

  console.log(await query([1, 2, 3], { vectorPath: "embedding", limit: 20 } ));
</script>
```
