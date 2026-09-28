import { describe, expect, test } from "bun:test";
import { createCloudflareClient, type WaitUntilContext } from "../src/index.js";

const packageMetadata = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as { version: string };

describe("createCloudflareClient", () => {
  test("sends nothing when the dsn is empty", async () => {
    const client = createCloudflareClient({
      dsn: "",
      environment: "test",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });
    expect(await client.captureException(new Error("x"))).toBeNull();
    expect((await client.flush()).accepted).toBe(true);
  });

  test("normalizes and flushes an exception through waitUntil", async () => {
    let request: Request | undefined;
    let background: Promise<unknown> | undefined;
    const client = createCloudflareClient({
      dsn: "https://msk_test@ingest.example.test/project-sample",
      environment: "production",
      release: "worker-version-id",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });
    const cause = new TypeError("root cause");
    const error = new Error("worker failed", { cause });
    error.stack = [
      "Error: worker failed",
      "    at handler (https://app.example/src/index.ts:10:20)",
    ].join("\n");
    const executionContext: WaitUntilContext = {
      waitUntil(promise) {
        background = promise;
      },
    };

    client.captureExceptionInBackground(executionContext, error, {
      tags: { operation: "handle-request" },
    });
    expect(background).toBeDefined();
    await background;

    expect(request?.headers.get("Authorization")).toBe("Bearer msk_test");
    const envelope = await readEnvelope(request);
    expect(envelope.sdk).toEqual({
      name: "@ah-monica/cloudflare",
      version: packageMetadata.version,
    });
    expect(envelope.items[0]).toMatchObject({
      platform: "javascript",
      environment: "production",
      release: "worker-version-id",
      message: "worker failed",
      tags: { operation: "handle-request" },
      exception: {
        values: [
          {
            type: "Error",
            value: "worker failed",
            mechanism: { type: "generic", handled: true },
            stacktrace: {
              frames: [
                {
                  filename: "https://app.example/src/index.ts",
                  function: "handler",
                  lineno: 10,
                  colno: 20,
                  in_app: true,
                },
              ],
            },
          },
          {
            type: "TypeError",
            value: "root cause",
            mechanism: { type: "generic", handled: true },
          },
        ],
      },
    });
  });

  test("leaves PII decisions to beforeSend", async () => {
    let request: Request | undefined;
    const client = createCloudflareClient({
      dsn: "https://msk_test@ingest.example.test/project-sample",
      environment: "test",
      beforeSend(item) {
        delete item.user;
        if (item.request) delete item.request.headers;
        item.message = item.message?.replace("user@example.com", "[REDACTED]");
        for (const value of item.exception?.values ?? []) {
          value.value = value.value.replace("user@example.com", "[REDACTED]");
        }
        return item;
      },
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });

    await client.captureException(new Error("failed for user@example.com"), {
      user: { email: "user@example.com" },
      request: {
        method: "POST",
        url: "https://app.example/jobs",
        headers: { Authorization: "Bearer application-secret" },
      },
    });

    const envelope = await readEnvelope(request);
    expect(envelope.items[0]?.message).toBe("failed for [REDACTED]");
    expect(envelope.items[0]?.user).toBeUndefined();
    expect(envelope.items[0]?.request).toEqual({
      method: "POST",
      url: "https://app.example/jobs",
    });
  });

  test("does not let transport failures reject the Worker task", async () => {
    const client = createCloudflareClient({
      dsn: "https://msk_test@ingest.example.test/project-sample",
      environment: "test",
      fetch: async () => {
        throw new Error("network unavailable");
      },
    });

    await expect(client.captureMessage("still safe")).resolves.toBeString();
  });

  test("does not let malformed exception objects reject the Worker task", async () => {
    let request: Request | undefined;
    const client = createCloudflareClient({
      dsn: "https://msk_test@ingest.example.test/project-sample",
      environment: "test",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });
    const error = new Error("hostile stack");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("stack getter failed");
      },
    });

    await expect(client.captureException(error)).resolves.toBeString();
    const envelope = await readEnvelope(request);
    expect(envelope.items[0]).toMatchObject({
      message: "hostile stack",
      exception: { values: [{ type: "Error", value: "hostile stack" }] },
    });
  });

  test("validates Cloudflare-specific limits", () => {
    expect(() =>
      createCloudflareClient({
        dsn: "https://msk_test@ingest.example.test/project-sample",
        environment: "test",
        maxCauseDepth: 0,
      }),
    ).toThrow("maxCauseDepth");
  });
});

interface CapturedEnvelope {
  sdk: { name: string; version: string };
  items: Array<{
    platform: string;
    environment: string;
    release?: string;
    message?: string;
    exception?: { values: Array<{ value: string }> };
    tags?: Record<string, string>;
    user?: unknown;
    request?: { method: string; url: string; headers?: Record<string, string> };
  }>;
}

async function readEnvelope(request: Request | undefined): Promise<CapturedEnvelope> {
  if (!request?.body) throw new Error("MONICA request was not captured");
  const stream = request.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json() as Promise<CapturedEnvelope>;
}

describe("稼働確認（client_report）", () => {
  function recordingFetch(items: Array<Record<string, unknown>>, status = 202) {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const envelope = (await readEnvelope(new Request(input, init))) as unknown as {
        items: Array<Record<string, unknown>>;
      };
      expect(envelope.items).toHaveLength(1);
      items.push(envelope.items[0]!);
      return new Response(null, { status });
    };
  }

  test("isolate ごとに start を 1 回だけ送り、waitUntil に載せた capture がそれも待つ", async () => {
    const items: Array<Record<string, unknown>> = [];
    const options = {
      dsn: "https://msk_test@ingest.example.test/project-presence",
      environment: "production",
      release: "worker-version-id",
      fetch: recordingFetch(items),
    };
    let background: Promise<unknown> | undefined;
    createCloudflareClient(options).captureExceptionInBackground(
      { waitUntil: (promise) => void (background = promise) },
      new Error("first"),
    );
    await background;
    expect(items.map((item) => item.type)).toEqual(["client_report", "error"]);
    expect(items[0]).toEqual({
      type: "client_report",
      timestamp: expect.any(String),
      platform: "javascript",
      environment: "production",
      trigger: "start",
      release: "worker-version-id",
    });

    // 同じ isolate で request ごとに作り直しても start は送らない
    await createCloudflareClient(options).captureMessage("second");
    expect(items.map((item) => item.type)).toEqual(["client_report", "error", "error"]);

    // environment が違えば別に数える
    const other = createCloudflareClient({ ...options, environment: "staging" });
    await other.flush();
    expect(items.map((item) => item.type)).toEqual([
      "client_report",
      "error",
      "error",
      "client_report",
    ]);
  });

  test("start が受理されなければ次の client で送り直す", async () => {
    const items: Array<Record<string, unknown>> = [];
    const options = {
      dsn: "https://msk_test@ingest.example.test/project-presence-retry",
      environment: "production",
      onDiagnostic: null,
    };
    await createCloudflareClient({ ...options, fetch: recordingFetch(items, 503) }).flush();
    await createCloudflareClient({ ...options, fetch: recordingFetch(items) }).flush();
    await createCloudflareClient({ ...options, fetch: recordingFetch(items) }).flush();
    expect(items.map((item) => item.trigger)).toEqual(["start", "start"]);
  });
});
