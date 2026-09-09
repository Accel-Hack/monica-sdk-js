import assert from "node:assert/strict";
import { createNodeClient } from "../dist/index.js";

let request;
const client = createNodeClient({
  dsn: "https://msk_test@ingest.example.test/1",
  environment: "test",
  batchSize: 1,
  fetch: async (input, init) => {
    request = new Request(input, init);
    return new Response(null, { status: 202 });
  },
});

await client.captureMessage("Node runtime smoke test");
const result = await client.flush();
assert.equal(result.accepted, true);
assert.equal(request.headers.get("Authorization"), "Bearer msk_test");
const decompressed = new Response(
  request.body.pipeThrough(new DecompressionStream("gzip")),
);
const envelope = await decompressed.json();
assert.equal(envelope.items[0].message, "Node runtime smoke test");
assert.equal(envelope.items[0].platform, "node");
await client.close();
