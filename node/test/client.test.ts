import { afterEach, describe, expect, jest, test } from "bun:test";
import process from "node:process";
import { createNodeClient, type MonicaItem } from "../src/index.js";

const packageMetadata = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as { version: string };

describe("createNodeClient", () => {
  afterEach(() => {
    expect(unexpectedEnvelopes.splice(0)).toEqual([]);
  });

  test("sends nothing without a dsn", async () => {
    const client = createNodeClient({ dsn: undefined, environment: "test", fetch: unexpectedFetch });
    expect(await client.captureException(new Error("x"))).toBeNull();
    expect((await client.close()).accepted).toBe(true);
  });

  test("isolates scope across concurrent asynchronous work", async () => {
    const users: unknown[] = [];
    const client = createNodeClient({
      dsn: "https://secret@ingest.example.test/1",
      environment: "test",
      beforeSend(item) {
        users.push(item.user);
        return null;
      },
      fetch: unexpectedFetch,
    });

    await Promise.all([
      client.withScope(async (scope) => {
        scope.setUser({ id: "user-a" });
        await Promise.resolve();
        await client.captureMessage("from a");
      }),
      client.withScope(async (scope) => {
        scope.setUser({ id: "user-b" });
        await Promise.resolve();
        await client.captureMessage("from b");
      }),
    ]);

    expect(users).toEqual(expect.arrayContaining([{ id: "user-a" }, { id: "user-b" }]));
  });

  test("serializes errors and lets the application remove PII", async () => {
    let captured: MonicaItem | undefined;
    const client = createNodeClient({
      dsn: "https://secret@ingest.example.test/1",
      environment: "production",
      beforeSend(item) {
        captured = structuredClone(item);
        delete item.user;
        return null;
      },
      fetch: unexpectedFetch,
    });
    client.setUser({ email: "person@example.test" });

    const error = new Error("database failed", { cause: new TypeError("bad input") });
    await client.captureException(error, { tags: { component: "server-runtime" } });

    expect(captured?.platform).toBe("node");
    expect(captured?.environment).toBe("production");
    expect(captured?.user).toEqual({ email: "person@example.test" });
    expect(captured?.tags).toEqual({ component: "server-runtime" });
    expect(
      (captured?.exception as { values: Array<{ value: string }> }).values.map(
        (value) => value.value,
      ),
    ).toEqual(["database failed", "bad input"]);
  });

  test("reports the version from the published package metadata", async () => {
    let request: Request | undefined;
    const client = createNodeClient({
      dsn: "https://secret@ingest.example.test/1",
      environment: "test",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });

    await client.captureMessage("version check");
    await client.flush();

    if (!request?.body) throw new Error("MONICA request was not captured");
    const stream = request.body.pipeThrough(new DecompressionStream("gzip"));
    const envelope = (await new Response(stream).json()) as {
      sdk?: { name?: string; version?: string };
    };
    expect(envelope.sdk).toEqual({
      name: "@ah-monica/node",
      version: packageMetadata.version,
    });
  });

  test("registers process hooks only when explicitly requested and removes them", () => {
    const client = createNodeClient({
      dsn: "https://secret@ingest.example.test/1",
      environment: "test",
      fetch: unexpectedFetch,
    });
    const uncaughtBefore = process.listenerCount("uncaughtExceptionMonitor");
    const rejectionBefore = process.listenerCount("unhandledRejection");
    const uninstall = client.installProcessHooks({ unhandledRejection: true });
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(uncaughtBefore + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore + 1);
    uninstall();
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(uncaughtBefore);
    expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore);
  });

  test("marks process-hook exceptions as unhandled onerror events", async () => {
    let captured: MonicaItem | undefined;
    const client = createNodeClient({
      dsn: "https://secret@ingest.example.test/1",
      environment: "test",
      beforeSend(item) {
        captured = structuredClone(item);
        return null;
      },
      fetch: unexpectedFetch,
    });
    const uninstall = client.installProcessHooks();
    const events = process as unknown as {
      emit(event: "uncaughtExceptionMonitor", error: Error, origin: string): boolean;
    };
    events.emit("uncaughtExceptionMonitor", new Error("fatal"), "uncaughtException");
    await Promise.resolve();
    uninstall();

    const mechanism = (captured?.exception as {
      values: Array<{ mechanism: { type: string; handled: boolean } }>;
    }).values[0]?.mechanism;
    expect(mechanism).toEqual({ type: "onerror", handled: false });
  });

  test("recognizes Windows node_modules frames as dependencies", async () => {
    let captured: MonicaItem | undefined;
    const client = createNodeClient({
      dsn: "https://secret@ingest.example.test/1",
      environment: "test",
      beforeSend(item) {
        captured = structuredClone(item);
        return null;
      },
      fetch: unexpectedFetch,
    });
    const error = new Error("windows stack");
    error.stack = [
      "Error: windows stack",
      "    at dependency (C:\\app\\node_modules\\example\\index.js:10:2)",
      "    at application (C:\\app\\packages\\server\\index.ts:20:4)",
    ].join("\n");
    await client.captureException(error);

    const frames = (captured?.exception as {
      values: Array<{
        stacktrace: {
          frames: Array<{
            filename: string;
            function?: string;
            lineno?: number;
            colno?: number;
            in_app: boolean;
          }>;
        };
      }>;
    }).values[0]?.stacktrace.frames;
    expect(frames).toEqual([
      { filename: "C:\\app\\packages\\server\\index.ts", function: "application", lineno: 20, colno: 4, in_app: true },
      { filename: "C:\\app\\node_modules\\example\\index.js", function: "dependency", lineno: 10, colno: 2, in_app: false },
    ]);
  });
});

/** 生成時の client_report だけは受理する。それ以外の envelope が来たら記録して後で落とす */
const unexpectedEnvelopes: string[][] = [];
async function unexpectedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const stream = request.body!.pipeThrough(new DecompressionStream("gzip"));
  const envelope = (await new Response(stream).json()) as { items: Array<{ type: string }> };
  const types = envelope.items.map((item) => item.type);
  if (types.some((type) => type !== "client_report")) unexpectedEnvelopes.push(types);
  return new Response(null, { status: 202 });
}

describe("稼働確認（client_report）", () => {
  const DAY = 86_400_000;
  const T0 = Date.parse("2026-08-30T00:00:00.000Z");

  afterEach(() => {
    jest.useRealTimers();
  });

  /** fake clock の上で、受け取った envelope の item を記録する client */
  function recordingClient(headers: Record<string, string> = {}) {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const items: Array<Record<string, unknown>> = [];
    const client = createNodeClient({
      dsn: "https://secret@ingest.example.test/1",
      environment: "production",
      release: "1.2.3",
      batchSize: 1,
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const stream = request.body!.pipeThrough(new DecompressionStream("gzip"));
        const envelope = (await new Response(stream).json()) as {
          items: Array<Record<string, unknown>>;
        };
        expect(envelope.items).toHaveLength(1);
        items.push(envelope.items[0]!);
        return new Response(null, { status: 202, headers });
      },
    });
    const reports = () => items.filter((item) => item.type === "client_report");
    /** 時計とタイマーを進め、発火した送信が終わるまで待つ */
    async function advance(ms: number) {
      jest.setSystemTime(Date.now() + ms);
      jest.advanceTimersByTime(ms);
      await client.flush();
    }
    return { client, items, reports, advance };
  }

  test("init で start を送り、202 から 1 日沈黙すると interval を 1 通送る", async () => {
    const { client, reports, advance } = recordingClient();
    await client.flush();
    expect(reports()).toEqual([
      {
        type: "client_report",
        timestamp: "2026-08-30T00:00:00.000Z",
        platform: "node",
        environment: "production",
        trigger: "start",
        release: "1.2.3",
      },
    ]);
    await advance(DAY - 1);
    expect(reports()).toHaveLength(1);
    await advance(1);
    expect(reports().map((item) => item.trigger)).toEqual(["start", "interval"]);
    await advance(DAY - 1);
    expect(reports()).toHaveLength(2);
    await client.close();
  });

  test("error envelope の 202 で期限が伸び、残り時間で張り直す", async () => {
    const { client, items, reports, advance } = recordingClient();
    await client.flush();
    await advance(DAY - 1_000);
    await client.captureMessage("still alive");
    await client.flush();
    expect(items).toHaveLength(2);
    await advance(1_000);
    expect(reports()).toHaveLength(1);
    await advance(DAY - 1_000);
    expect(reports().map((item) => item.trigger)).toEqual(["start", "interval"]);
    await client.close();
  });

  test("202 の header の interval を次の判定から使う", async () => {
    const { client, reports, advance } = recordingClient({
      "X-Monica-Presence-Interval-Ms": "3600000",
    });
    await client.flush();
    await advance(3_600_000);
    expect(reports().map((item) => item.trigger)).toEqual(["start", "interval"]);
    await client.close();
  });

  test("close() のあとはタイマーで送らない", async () => {
    const { client, reports, advance } = recordingClient();
    await client.close();
    await advance(DAY * 2);
    expect(reports()).toHaveLength(1);
  });

  test("next build の worker からは start を送らない", async () => {
    const phase = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = "phase-production-build";
    try {
      const { client, reports } = recordingClient();
      await client.flush();
      expect(reports()).toHaveLength(0);
      await client.close();
    } finally {
      if (phase === undefined) delete process.env.NEXT_PHASE;
      else process.env.NEXT_PHASE = phase;
    }
  });
});
