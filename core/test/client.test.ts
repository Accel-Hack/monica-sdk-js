import { describe, expect, test } from "bun:test";
import {
  createCoreClient,
  type CaptureItemInput,
  type MonicaEnvelope,
  type MonicaItem,
  type MonicaTransport,
  type PresenceState,
  type PresenceStore,
  type TransportResult,
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
    expect(envelopes.map((envelope) => (envelope.items[0] as MonicaItem | undefined)?.message)).toEqual([
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

describe("checkPresence", () => {
  const DAY = 86_400_000;

  /** 時刻を進められる時計と、応答を差し替えられる transport */
  function presenceHarness(
    options: { applySampleRate?: boolean; random?: () => number; store?: PresenceStore } = {},
  ) {
    let clock = Date.parse("2026-08-30T00:00:00.000Z");
    const envelopes: MonicaEnvelope[] = [];
    let respond = (): TransportResult => ({ accepted: true, status: 202 });
    const client = createCoreClient({
      transport: {
        async send(envelope) {
          envelopes.push(envelope);
          return respond();
        },
      },
      environment: "production",
      release: "1.2.3",
      now: () => new Date(clock),
      random: options.random,
      presence: {
        platform: "node",
        applySampleRate: options.applySampleRate,
        store: options.store,
      },
    });
    const reports = () =>
      envelopes.filter((envelope) => envelope.items[0]?.type === "client_report");
    return {
      client,
      envelopes,
      reports,
      advance(ms: number) {
        clock += ms;
      },
      respondWith(next: () => TransportResult) {
        respond = next;
      },
    };
  }

  test("start の client_report を単独の envelope で送る", async () => {
    const { client, envelopes } = presenceHarness();
    expect(await client.checkPresence("start")).toBe(DAY);
    expect(envelopes).toEqual([
      {
        sdk: { name: "@ah-monica/core", version: packageMetadata.version },
        sent_at: "2026-08-30T00:00:00.000Z",
        discarded: 0,
        items: [
          {
            type: "client_report",
            timestamp: "2026-08-30T00:00:00.000Z",
            platform: "node",
            environment: "production",
            trigger: "start",
            release: "1.2.3",
          },
        ],
      },
    ]);
  });

  test("presence を渡していない client は何も送らない", async () => {
    const envelopes: MonicaEnvelope[] = [];
    const client = createCoreClient({
      transport: { send: async (envelope) => (envelopes.push(envelope), { accepted: true }) },
      environment: "production",
    });
    await client.checkPresence("start");
    expect(envelopes).toHaveLength(0);
  });

  test("202 から interval 未満は送らず、以上沈黙すると 1 通だけ送る", async () => {
    const h = presenceHarness();
    await h.client.checkPresence("start");
    h.advance(DAY - 1);
    expect(await h.client.checkPresence("interval")).toBe(1);
    expect(h.reports()).toHaveLength(1);
    h.advance(1);
    expect(await h.client.checkPresence("interval")).toBe(DAY);
    expect(await h.client.checkPresence("interval")).toBe(DAY);
    expect(h.reports().map((envelope) => envelope.items[0])).toMatchObject([
      { trigger: "start" },
      { trigger: "interval" },
    ]);
  });

  test("error envelope の 202 で期限が伸びる", async () => {
    const h = presenceHarness();
    await h.client.checkPresence("start");
    h.advance(DAY - 1_000);
    await h.client.capture({ type: "error", platform: "node", level: "error" });
    await h.client.flush();
    h.advance(1_000);
    expect(await h.client.checkPresence("interval")).toBe(DAY - 1_000);
    expect(h.reports()).toHaveLength(1);
  });

  test("queue に error が溜まっている間は送らない", async () => {
    const h = presenceHarness();
    await h.client.capture({ type: "error", platform: "node", level: "error" });
    expect(await h.client.checkPresence("start")).toBe(60_000);
    expect(h.envelopes).toHaveLength(0);
    await h.client.close();
  });

  test("送信中の envelope があれば送らず、下限の間隔で見直す", async () => {
    const envelopes: MonicaEnvelope[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = createCoreClient({
      transport: {
        async send(envelope) {
          envelopes.push(envelope);
          await blocked;
          return { accepted: true, status: 202 };
        },
      },
      environment: "production",
      presence: { platform: "node" },
    });
    // fatal は即座に送られ、応答を待っている間は sending が立つ
    await client.capture({ type: "error", platform: "node", level: "fatal" });
    expect(await client.checkPresence("start")).toBe(60_000);
    release?.();
    await client.flush();
    expect(envelopes.map((envelope) => envelope.items[0]?.type)).toEqual(["error"]);
  });

  test("失敗した heartbeat は interval 内に再送せず、次の interval で送り直す", async () => {
    const h = presenceHarness();
    h.respondWith(() => ({ accepted: false, status: 503 }));
    expect(await h.client.checkPresence("start")).toBe(DAY);
    h.respondWith(() => ({ accepted: true, status: 202 }));
    h.advance(DAY - 1);
    expect(await h.client.checkPresence("interval")).toBe(1);
    expect(h.reports()).toHaveLength(1);
    h.advance(1);
    expect(await h.client.checkPresence("interval")).toBe(DAY);
    expect(h.reports()).toHaveLength(2);
    // 捨てた 1 件は次の envelope の discarded に載る
    expect(h.reports()[1]?.discarded).toBe(1);
  });

  test("401 のあとは送らない", async () => {
    const h = presenceHarness();
    h.respondWith(() => ({ accepted: false, status: 401, stop: true }));
    await h.client.checkPresence("start");
    h.advance(DAY);
    await h.client.checkPresence("interval");
    expect(h.envelopes).toHaveLength(1);
  });

  test("202 の header の interval を保存し、壊れた header と header 無しでは保存値を残す", async () => {
    const h = presenceHarness();
    h.respondWith(() => ({ accepted: true, status: 202, presence: { intervalMs: "3600000" } }));
    expect(await h.client.checkPresence("start")).toBe(3_600_000);
    for (const broken of ["59999", "1e7", "3600000.5", "abc", "-3600000", ""]) {
      h.respondWith(() => ({ accepted: true, status: 202, presence: { intervalMs: broken } }));
      h.advance(3_600_000);
      expect(await h.client.checkPresence("interval"), broken).toBe(3_600_000);
    }
    h.respondWith(() => ({ accepted: true, status: 202 }));
    h.advance(3_600_000);
    expect(await h.client.checkPresence("interval")).toBe(3_600_000);
    h.advance(3_600_000 - 1);
    await h.client.checkPresence("interval");
    expect(h.reports()).toHaveLength(8);
  });

  test("配布物は保存した sample rate で間引き、サーバは間引かない", async () => {
    const distributed = presenceHarness({
      applySampleRate: true,
      random: () => 0.5,
      store: memoryStore({ sampleRate: 0.5 }),
    });
    await distributed.client.checkPresence("start");
    expect(distributed.envelopes).toHaveLength(0);

    const sampledIn = presenceHarness({
      applySampleRate: true,
      random: () => 0.49,
      store: memoryStore({ sampleRate: 0.5 }),
    });
    await sampledIn.client.checkPresence("start");
    expect(sampledIn.envelopes).toHaveLength(1);

    const server = presenceHarness({ random: () => 0.99, store: memoryStore({ sampleRate: 0.5 }) });
    await server.client.checkPresence("start");
    expect(server.envelopes).toHaveLength(1);
  });

  test("間引きで見送ったあと、同じ interval 内は抽選し直さない", async () => {
    const store = memoryStore({ sampleRate: 0.5 });
    let draws = 0;
    let next = 0.5;
    const random = () => {
      draws += 1;
      return next;
    };
    const first = presenceHarness({ applySampleRate: true, random, store });
    expect(await first.client.checkPresence("start")).toBe(DAY);
    expect(draws).toBe(1);

    // 作り直した client（次のページ読み込み）でも、同じ interval 内は抽選しない
    next = 0;
    const second = presenceHarness({ applySampleRate: true, random, store });
    second.advance(DAY - 1);
    expect(await second.client.checkPresence("start")).toBe(1);
    expect(draws).toBe(1);
    expect(second.envelopes).toHaveLength(0);

    second.advance(1);
    await second.client.checkPresence("interval");
    expect(draws).toBe(2);
    expect(second.envelopes).toHaveLength(1);
  });

  test("header の sample rate を保存し、範囲外や指数表記は無視する", async () => {
    const store = memoryStore({});
    const h = presenceHarness({ store });
    for (const [header, expected] of [
      ["0.25", 0.25],
      ["0.001", 0.25],
      ["1.5", 0.25],
      ["1e-1", 0.25],
      ["1", 1],
      ["0.01", 0.01],
    ] as const) {
      h.respondWith(() => ({ accepted: true, status: 202, presence: { sampleRate: header } }));
      await h.client.capture({ type: "error", platform: "node", level: "error" });
      await h.client.flush();
      expect(store.load()?.sampleRate, header).toBe(expected);
    }
  });

  test("差し替えた store に前回の 202 があれば、作り直しても interval 内は送らない", async () => {
    const store = memoryStore({});
    const first = presenceHarness({ store });
    await first.client.checkPresence("start");
    expect(first.envelopes).toHaveLength(1);
    const second = presenceHarness({ store });
    second.advance(DAY - 1);
    expect(await second.client.checkPresence("start")).toBe(1);
    expect(second.envelopes).toHaveLength(0);
  });

  test("store が throw しても送信は続く", async () => {
    const h = presenceHarness({
      store: {
        load: () => {
          throw new Error("denied");
        },
        save: () => {
          throw new Error("denied");
        },
      },
    });
    expect(await h.client.checkPresence("start")).toBe(DAY);
    expect(h.envelopes).toHaveLength(1);
  });
});

function memoryStore(initial: PresenceState): PresenceStore {
  let state: PresenceState | undefined = initial;
  return {
    load: () => state,
    save: (next) => {
      state = next;
    },
  };
}
