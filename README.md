# Vector IDB

IndexedDB as a Vector Database

## Introduction

IndexedDB as a Vector Database is a project that explores the concept of using IndexedDB as a vector database directly in the browser. It provides a simple wrapper over IndexedDB, allowing efficient storage and querying of vector data. This project was inspired by the existence of database companies that specialize in vector search and the usefulness of services like Polymath and Pinecone.

If you're unfamiliar with vector databases and their benefits, you can start by reading the article ["IndexedDB as a Vector Database"](https://paul.kinlan.me/idb-as-a-vector-database/).

## Usage

To use Vector IDB, you need to import the `VectorDB` class from the `idb-vector` package.

```javascript
import { VectorDB } from "idb-vector";
```

### Initialization

Create a new instance of `VectorDB` by providing the vector path.

```javascript
const db = new VectorDB({
	vectorPath: "embedding",
});
```

The `vectorPath` parameter specifies the property path in the JSON documents where the vector is stored. The vector should be represented as an array.

### Inserting Data

To insert data into the VectorDB, use the `insert` method. It returns a promise that resolves to the generated key.

```javascript
const key1 = await db.insert({
	embedding: [1, 2, 3],
	text: "ASDASINDASDASZd",
});
const key2 = await db.insert({
	embedding: [2, 3, 4],
	text: "GTFSDGRG",
});
const key3 = await db.insert({
	embedding: [73, -213, 3],
	text: "hYTRTERFR",
});
```

### Updating Data

To update existing data, use the `update` method. Provide the key of the entry to update and the updated data.

```javascript
await db.update(key2, {
	embedding: [2, 3, 4],
	text: "UPDATED",
});
```

### Deleting Data

To delete an entry from the VectorDB, use the `delete` method and provide the key.

```javascript
await db.delete(key3);
```

### Querying Data

To query the VectorDB based on vector similarity, use the `query` method. Provide the target vector and an optional configuration object. The method returns a promise that resolves to a list of entries ordered by cosine similarity.

```javascript
console.log(
	await db.query([1, 2, 3], {
		limit: 20,
	})
);
```

The `limit` option allows you to specify the maximum number of results to return.

## Limitations and Considerations

Vector IDB is a simple wrapper over IndexedDB and serves as a starting point for using IndexedDB as a vector database. It does not include advanced optimizations, pre-filtering of the query space, or extensive post-filtering capabilities. The goal of this project is to provide a simple solution for quick integration with IndexedDB, especially for applications that already have a complex IndexedDB setup.
