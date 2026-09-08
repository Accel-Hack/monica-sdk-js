import { describe, expect, test } from "bun:test";
import process from "node:process";
import { createNodeClient, type MonicaItem } from "../src/index.js";

const packageMetadata = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as { version: string };

describe("createNodeClient", () => {
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

async function unexpectedFetch(): Promise<Response> {
  throw new Error("fetch should not be called");
}
