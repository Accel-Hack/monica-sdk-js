import assert from "node:assert/strict";
import { createNextClient } from "../dist/client/index.js";
import { createNextServerClient } from "../dist/server/index.js";

assert.equal(typeof createNextClient, "function");
assert.equal(typeof createNextServerClient, "function");

assert.throws(
  () => createNextClient({ dsn: "https://msk_secret@example.test/1", environment: "test" }),
  /public mpk_ key/,
);

const server = createNextServerClient({
  dsn: "https://msk_test@ingest.example.test/1",
  environment: "test",
  fetch: async () => new Response(null, { status: 202 }),
});
assert.equal(typeof server.onRequestError, "function");
await server.close();
