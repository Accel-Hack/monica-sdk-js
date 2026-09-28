import { afterEach, describe, expect, jest, test } from "bun:test";
import { createNextClient, type MonicaItem } from "../src/client/index.js";

const originalAddEventListener = globalThis.addEventListener;
const originalRemoveEventListener = globalThis.removeEventListener;
const packageMetadata = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as { version: string };

afterEach(() => {
  if (originalAddEventListener) globalThis.addEventListener = originalAddEventListener;
  else delete (globalThis as Partial<typeof globalThis>).addEventListener;
  if (originalRemoveEventListener) globalThis.removeEventListener = originalRemoveEventListener;
  else delete (globalThis as Partial<typeof globalThis>).removeEventListener;
});

describe("createNextClient", () => {
  test("uses only public authentication in browser requests", async () => {
    let request: Request | undefined;
    const client = createNextClient({
      dsn: "https://mpk_test@ingest.example.test/project-sample",
      environment: "production",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });

    await client.captureException(new Error("client render failed"));
    await client.flush();

    expect(request?.headers.get("X-Monica-Key")).toBe("mpk_test");
    expect(request?.headers.get("Authorization")).toBeNull();
    const envelope = await readEnvelope(request);
    expect(envelope.sdk).toEqual({
      name: "@ah-monica/next",
      version: packageMetadata.version,
    });
    expect(envelope.items[0]).toMatchObject({
      platform: "javascript",
      environment: "production",
      message: "client render failed",
    });
  });

  test("sends nothing when the dsn is blank", async () => {
    const client = createNextClient({
      dsn: " ",
      environment: "test",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });
    expect(await client.captureException(new Error("x"))).toBeNull();
    expect((await client.flush()).accepted).toBe(true);
  });

  test("rejects a secret key before it can enter client code", () => {
    expect(() =>
      createNextClient({
        dsn: "https://msk_secret@ingest.example.test/project-sample",
        environment: "test",
      }),
    ).toThrow("public mpk_ key");
  });

  test("validates client-specific limits", () => {
    expect(() =>
      createNextClient({
        dsn: "https://mpk_test@ingest.example.test/project-sample",
        environment: "test",
        maxBreadcrumbs: 0,
      }),
    ).toThrow("maxBreadcrumbs");
  });

  test("leaves PII decisions to beforeSend", async () => {
    let request: Request | undefined;
    const client = createNextClient({
      dsn: "https://mpk_test@ingest.example.test/project-sample",
      environment: "test",
      beforeSend(item) {
        delete item.user;
        item.message = "[REDACTED]";
        return item;
      },
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });

    await client.captureException(new Error("user@example.com"), {
      user: { email: "user@example.com" },
    });
    await client.flush();

    const envelope = await readEnvelope(request);
    expect(envelope.items[0]?.message).toBe("[REDACTED]");
    expect(envelope.items[0]?.user).toBeUndefined();
  });

  test("parses Firefox and Safari style browser frames", async () => {
    let request: Request | undefined;
    const client = createNextClient({
      dsn: "https://mpk_test@ingest.example.test/project-sample",
      environment: "test",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });
    const error = new Error("browser failed");
    error.stack = "Error: browser failed\nrender@https://app.example/_next/app.js:12:34";

    await client.captureException(error);
    await client.flush();

    const item = (await readEnvelope(request)).items[0];
    expect(item?.exception?.values[0]?.stacktrace?.frames[0]).toMatchObject({
      filename: "https://app.example/_next/app.js",
      function: "render",
      lineno: 12,
      colno: 34,
    });
  });

  test("installs global handlers idempotently and removes them on close", async () => {
    const listeners = new Map<string, EventListener>();
    const removed: string[] = [];
    globalThis.addEventListener = ((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }) as typeof globalThis.addEventListener;
    globalThis.removeEventListener = ((type: string) => {
      removed.push(type);
      listeners.delete(type);
    }) as typeof globalThis.removeEventListener;
    const client = createNextClient({
      dsn: "https://mpk_test@ingest.example.test/project-sample",
      environment: "test",
      fetch: async () => new Response(null, { status: 202 }),
    });

    const first = client.installGlobalHandlers();
    const second = client.installGlobalHandlers();
    expect(second).toBe(first);
    expect([...listeners.keys()]).toEqual(["error", "unhandledrejection"]);

    await client.close();
    expect(removed).toEqual(["error", "unhandledrejection"]);
  });
});

interface CapturedEnvelope {
  sdk: { name: string; version: string };
  items: MonicaItem[];
}

async function readEnvelope(request: Request | undefined): Promise<CapturedEnvelope> {
  if (!request?.body) throw new Error("MONICA request was not captured");
  const stream = request.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json() as Promise<CapturedEnvelope>;
}

describe("稼働確認（client_report）", () => {
  const DAY = 86_400_000;
  const T0 = Date.parse("2026-08-30T00:00:00.000Z");
  const globals = globalThis as Record<string, unknown>;
  const saved = { window: globals.window, localStorage: globals.localStorage, random: Math.random };

  afterEach(() => {
    jest.useRealTimers();
    Math.random = saved.random;
    for (const name of ["window", "localStorage"] as const) {
      if (saved[name] === undefined) delete globals[name];
      else globals[name] = saved[name];
    }
  });

  function fakeStorage(): Storage {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    } as Storage;
  }

  /** ページ読み込み 1 回ぶん。受け取った client_report の数を返す */
  async function pageLoad(headers: Record<string, string> = {}): Promise<number> {
    let reports = 0;
    const client = createNextClient({
      dsn: "https://mpk_test@ingest.example.test/project-sample",
      environment: "production",
      fetch: async (input, init) => {
        const envelope = await readEnvelope(new Request(input, init));
        expect(envelope.items).toHaveLength(1);
        expect(envelope.items[0]).toMatchObject({
          type: "client_report",
          platform: "javascript",
          trigger: "start",
        });
        reports += 1;
        return new Response(null, { status: 202, headers });
      },
    });
    await client.flush();
    await client.close();
    return reports;
  }

  function inBrowser(storage: Storage | undefined): void {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    globals.window = globalThis;
    if (storage) globals.localStorage = storage;
  }

  test("ページ読み込みで start を送り、localStorage の時刻で interval 内は送らない", async () => {
    const storage = fakeStorage();
    inBrowser(storage);
    expect(await pageLoad()).toBe(1);
    expect(JSON.parse(storage.getItem("monica.presence")!)).toEqual({ intervalStartedAt: T0 });
    jest.setSystemTime(T0 + DAY - 1);
    expect(await pageLoad()).toBe(0);
    jest.setSystemTime(T0 + DAY);
    expect(await pageLoad()).toBe(1);
  });

  test("202 の header の値を localStorage に保存し、sample rate で間引く", async () => {
    const storage = fakeStorage();
    inBrowser(storage);
    expect(
      await pageLoad({
        "X-Monica-Presence-Interval-Ms": "3600000",
        "X-Monica-Presence-Sample-Rate": "0.25",
      }),
    ).toBe(1);
    expect(JSON.parse(storage.getItem("monica.presence")!)).toEqual({
      intervalStartedAt: T0,
      intervalMs: 3_600_000,
      sampleRate: 0.25,
    });
    jest.setSystemTime(T0 + 3_600_000);
    Math.random = () => 0.25;
    expect(await pageLoad()).toBe(0);
    // 間引きで見送ったら、同じ interval 内の読み込みでは抽選し直さない
    Math.random = () => 0;
    expect(await pageLoad()).toBe(0);
    jest.setSystemTime(T0 + 2 * 3_600_000);
    Math.random = () => 0.24;
    // header 無しの応答では保存値を残す
    expect(await pageLoad()).toBe(1);
    expect(JSON.parse(storage.getItem("monica.presence")!)).toMatchObject({
      intervalMs: 3_600_000,
      sampleRate: 0.25,
    });
  });

  test("storage が無ければメモリに持ち、読み込みごとに送る", async () => {
    inBrowser(undefined);
    expect(await pageLoad()).toBe(1);
    expect(await pageLoad()).toBe(1);
  });

  test("SSR（window が無い）では送らない", async () => {
    expect(globals.window).toBeUndefined();
    expect(await pageLoad()).toBe(0);
  });
});
