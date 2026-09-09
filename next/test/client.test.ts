import { afterEach, describe, expect, test } from "bun:test";
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
