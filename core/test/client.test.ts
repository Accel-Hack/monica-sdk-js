import { describe, expect, test } from "bun:test";
import {
  createCoreClient,
  type CaptureItemInput,
  type MonicaEnvelope,
  type MonicaTransport,
} from "../src/index.js";

const packageMetadata = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as { version: string };

describe("createCoreClient", () => {
  test("buffers an event and sends a protocol envelope", async () => {
    const envelopes: MonicaEnvelope[] = [];
    const transport: MonicaTransport = {
      async send(envelope) {
        envelopes.push(envelope);
        return { accepted: true, status: 202 };
      },
    };
    const client = createCoreClient({
      transport,
      environment: "test",
      release: "abc123",
      batchSize: 10,
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      generateEventId: () => "00000000-0000-4000-8000-000000000001",
    });

    await client.capture({
      type: "error",
      platform: "node",
      level: "error",
      message: "boom",
    });
    expect(await client.flush()).toEqual({ accepted: true, discarded: 0, remaining: 0 });
    expect(envelopes).toEqual([
      {
        sdk: { name: "@ah-monica/core", version: packageMetadata.version },
        sent_at: "2026-08-29T00:00:00.000Z",
        discarded: 0,
        items: [
          {
            type: "error",
            platform: "node",
            level: "error",
            message: "boom",
            event_id: "00000000-0000-4000-8000-000000000001",
            timestamp: "2026-08-29T00:00:00.000Z",
            environment: "test",
            release: "abc123",
          },
        ],
      },
    ]);
  });

  test("does not infer PII and delegates removal to beforeSend", async () => {
    let observedEmail: unknown;
    const client = createCoreClient({
      transport: acceptingTransport(),
      environment: "test",
      beforeSend(item) {
        observedEmail = item.user && typeof item.user === "object"
          ? (item.user as { email?: unknown }).email
          : undefined;
        delete item.user;
        return item;
      },
    });

    await client.capture({
      type: "error",
      platform: "node",
      level: "error",
      user: { email: "person@example.test" },
    });
    await client.flush();
    expect(observedEmail).toBe("person@example.test");
  });

  test("turns beforeSend failures into a dropped capture instead of host failure", async () => {
    const client = createCoreClient({
      transport: acceptingTransport(),
      environment: "test",
      beforeSend() {
        throw new Error("application hook failed");
      },
    });

    await expect(
      client.capture({ type: "error", platform: "node", level: "error" }),
    ).resolves.toBeNull();
  });

  test("sends fatal events immediately without waiting for the interval", async () => {
    let resolveSend: (() => void) | undefined;
    const sent = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const client = createCoreClient({
      environment: "test",
      flushIntervalMs: 60_000,
      transport: {
        async send() {
          resolveSend?.();
          return { accepted: true };
        },
      },
    });

    await client.capture({ type: "error", platform: "node", level: "fatal" });
    await sent;
  });

  test("drops a single item that cannot fit within the ingest envelope limit", async () => {
    let sends = 0;
    const client = createCoreClient({
      environment: "test",
      transport: {
        async send() {
          sends += 1;
          return { accepted: true };
        },
      },
    });

    await client.capture({
      type: "error",
      platform: "node",
      level: "error",
      message: "x".repeat(1_100_000),
    });
    expect(await client.flush()).toEqual({ accepted: false, discarded: 1, remaining: 0 });
    expect(sends).toBe(0);
  });

  test("rejects invalid numeric options", () => {
    expect(() =>
      createCoreClient({
        environment: "test",
        transport: acceptingTransport(),
        sampleRate: Number.NaN,
      }),
    ).toThrow("sampleRate");
  });

  test("rejects an environment outside the protocol boundary", () => {
    expect(() =>
      createCoreClient({
        environment: "x".repeat(129),
        transport: acceptingTransport(),
      }),
    ).toThrow("environment must not exceed 128 characters");
  });

  test("requires every captured error to satisfy the protocol fields", () => {
    // @ts-expect-error level and platform are required for an error item
    const invalid: CaptureItemInput = { type: "error" };
    expect(invalid.type).toBe("error");
  });

  test("bounds the queue while a send is in flight and reports the dropped item", async () => {
    const envelopes: MonicaEnvelope[] = [];
    let releaseFirstSend: (() => void) | undefined;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const client = createCoreClient({
      environment: "test",
      batchSize: 1,
      maxQueueSize: 2,
      transport: {
        async send(envelope) {
          envelopes.push(envelope);
          if (envelopes.length === 1) await firstSend;
          return { accepted: true };
        },
      },
    });

    await client.capture(errorInput("one"));
    await client.capture(errorInput("two"));
    await client.capture(errorInput("three"));
    await client.capture(errorInput("four"));
    releaseFirstSend?.();
    expect(await client.flush()).toEqual({ accepted: true, discarded: 0, remaining: 0 });
    expect(envelopes.map((envelope) => envelope.items[0]?.message)).toEqual([
      "one",
      "three",
      "four",
    ]);
    expect(envelopes[1]?.discarded).toBe(1);
  });

  test("reports a failed batch as discarded on the next accepted envelope", async () => {
    const envelopes: MonicaEnvelope[] = [];
    const client = createCoreClient({
      environment: "test",
      batchSize: 1,
      transport: {
        async send(envelope) {
          envelopes.push(envelope);
          return { accepted: envelopes.length > 1 };
        },
      },
    });

    await client.capture(errorInput("failed"));
    expect(await client.flush()).toEqual({ accepted: false, discarded: 1, remaining: 0 });
    await client.capture(errorInput("accepted"));
    expect(await client.flush()).toEqual({ accepted: true, discarded: 0, remaining: 0 });
    expect(envelopes[1]?.discarded).toBe(1);
  });
});

function acceptingTransport(): MonicaTransport {
  return { send: async () => ({ accepted: true }) };
}

function errorInput(message: string): CaptureItemInput {
  return { type: "error", platform: "node", level: "error", message };
}
