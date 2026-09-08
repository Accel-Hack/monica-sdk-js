import { expect, test } from "bun:test";
import { createFetchTransport, type MonicaEnvelope } from "../src/index.js";

test("fetch transport sends a gzip envelope with secret authentication", async () => {
  let request: Request | undefined;
  const transport = createFetchTransport({
    dsn: "https://secret%20key@ingest.example.test/42",
    maxRetries: 0,
    fetch: async (input, init) => {
      request = new Request(input, init);
      return new Response(null, { status: 202 });
    },
  });
  const envelope: MonicaEnvelope = {
    sdk: { name: "test", version: "1" },
    sent_at: "2026-08-29T00:00:00.000Z",
    discarded: 0,
    items: [],
  };

  expect(await transport.send(envelope)).toEqual({ accepted: true, status: 202 });
  expect(request?.url).toBe("https://ingest.example.test/v1/envelope");
  expect(request?.headers.get("Authorization")).toBe("Bearer secret key");
  expect(request?.headers.get("Content-Encoding")).toBe("gzip");
  const decompressed = new Response(
    request?.body?.pipeThrough(new DecompressionStream("gzip")),
  );
  expect(await decompressed.json()).toEqual(envelope);
});

test("fetch transport does not retry a non-429 client error", async () => {
  let attempts = 0;
  const transport = createFetchTransport({
    dsn: "https://secret@ingest.example.test/42",
    maxRetries: 5,
    fetch: async () => {
      attempts += 1;
      return new Response(null, { status: 400 });
    },
  });

  expect(
    await transport.send({
      sdk: { name: "test", version: "1" },
      sent_at: new Date().toISOString(),
      discarded: 0,
      items: [],
    }),
  ).toEqual({ accepted: false, status: 400 });
  expect(attempts).toBe(1);
});

test("fetch transport retries a rate limit response and supports public authentication", async () => {
  const requests: Request[] = [];
  const transport = createFetchTransport({
    dsn: "https://public-key@ingest.example.test/42",
    auth: "public",
    maxRetries: 1,
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return requests.length === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
        : new Response(null, { status: 202 });
    },
  });

  expect(
    await transport.send({
      sdk: { name: "test", version: "1" },
      sent_at: new Date().toISOString(),
      discarded: 0,
      items: [],
    }),
  ).toEqual({ accepted: true, status: 202 });
  expect(requests).toHaveLength(2);
  expect(requests[0]?.headers.get("X-Monica-Key")).toBe("public-key");
  expect(requests[0]?.headers.has("Authorization")).toBeFalse();
});

test("fetch transport validates retry and timeout options", () => {
  expect(() =>
    createFetchTransport({
      dsn: "https://secret@ingest.example.test/42",
      maxRetries: -1,
    }),
  ).toThrow("maxRetries");
  expect(() =>
    createFetchTransport({
      dsn: "https://secret@ingest.example.test/42",
      requestTimeoutMs: 0,
    }),
  ).toThrow("requestTimeoutMs");
});
