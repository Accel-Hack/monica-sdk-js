/**
 * Node adapter が実際に線に載せる envelope を、vendoring した公開契約
 * （spec/v1/envelope.json と payload.md）に照らす。上限・enum・pattern は schema から読む。
 */
import { describe, expect, test } from "bun:test";
import {
  compileEnvelopeValidator,
  decodeGzipBody,
  definition,
  describeErrors,
  enumOf,
  errorItemProperty,
  readEnvelopeSchema,
  readLimits,
} from "../../tooling/contract.js";
import { createNodeClient } from "../src/index.js";

const schema = await readEnvelopeSchema();
const limits = await readLimits();
const validate = await compileEnvelopeValidator();
const packageMetadata = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  name: string;
  version: string;
};

interface Envelope {
  sdk: { name: string; version: string };
  items: Array<Record<string, unknown>>;
}

async function capturedEnvelope(): Promise<{ envelope: Envelope; request: Request }> {
  let request: Request | undefined;
  const client = createNodeClient({
    dsn: "https://msk_example@ingest.example.test/1",
    environment: "production",
    release: "1.2.3",
    batchSize: 1,
    maxRetries: 0,
    fetch: async (input, init) => {
      request = new Request(input, init);
      return new Response(null, { status: 202 });
    },
  });
  client.setUser({ id: "u_123" });
  client.addBreadcrumb({ category: "ui.click", message: "submit" });
  const outer = new Error("boom", { cause: new TypeError("cause") });
  await client.captureException(outer, {
    tags: { component: "server" },
    contexts: { runtime: { name: "node" } },
    request: { url: "https://app.example/", method: "GET" },
    fingerprint: ["custom"],
  });
  await client.close();
  if (!request) throw new Error("nothing was sent");
  return { envelope: (await decodeGzipBody(request)) as Envelope, request };
}

describe("public contract: @ah-monica/node", () => {
  test("捕捉した例外の envelope が schema を通る", async () => {
    const { envelope, request } = await capturedEnvelope();
    expect(request.url).toBe("https://ingest.example.test/v1/envelope");
    expect(request.headers.get("Authorization")).toBe("Bearer msk_example");
    expect(validate(envelope), describeErrors(validate)).toBe(true);
    expect(envelope.sdk).toEqual({ name: packageMetadata.name, version: packageMetadata.version });
  });

  test("platform と mechanism.type は schema の enum にあり、必須項目が揃う", async () => {
    const { envelope } = await capturedEnvelope();
    const item = envelope.items[0]!;
    for (const required of definition(schema, "errorItem").required as string[]) {
      expect(item, `item is missing ${required}`).toHaveProperty(required);
    }
    expect(enumOf(errorItemProperty(schema, "platform"))).toContain(item.platform as string);
    expect(item.platform).toBe("node");
    expect(item.release).toBe("1.2.3");
    expect(item.user).toEqual({ id: "u_123" });
    expect(item.tags).toEqual({ component: "server" });
    expect(item.fingerprint).toEqual(["custom"]);
  });

  test("payload.md: exception.values は外側から内側、frames は呼び出し元から throw 地点の順", async () => {
    const { envelope } = await capturedEnvelope();
    const values = (envelope.items[0]!.exception as { values: Array<Record<string, unknown>> })
      .values;
    expect(values).toHaveLength(2);
    expect(values[0]!.type).toBe("Error");
    expect(values[1]!.type).toBe("TypeError");

    const mechanismEnum = enumOf(
      (definition(schema, "mechanism").properties as Record<string, never>).type,
    );
    for (const value of values) {
      for (const required of definition(schema, "exceptionValue").required as string[]) {
        expect(value, `exception value is missing ${required}`).toHaveProperty(required);
      }
      const mechanism = value.mechanism as { type: string; handled: boolean };
      expect(mechanismEnum).toContain(mechanism.type);
      expect(mechanism.handled).toBe(true);
    }

    const frames = (values[0]!.stacktrace as { frames: Array<Record<string, unknown>> }).frames;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(limits.frames_per_stacktrace);
    // V8 の stack は throw 地点が先頭。契約は呼び出し元が先なので、この test file の
    // フレームが末尾側に来る
    const throwSite = lastIndexWhere(frames, (frame) =>
      String(frame.filename).endsWith("contract.test.ts"),
    );
    expect(throwSite).toBeGreaterThanOrEqual(0);
    expect(throwSite).toBeGreaterThanOrEqual(frames.length - 2);
    for (const frame of frames) {
      for (const required of definition(schema, "frame").required as string[]) {
        expect(frame, `frame is missing ${required}`).toHaveProperty(required);
      }
      expect(String(frame.filename).length).toBeGreaterThan(0);
      expect(typeof frame.in_app).toBe("boolean");
      if (frame.lineno !== undefined) expect(frame.lineno as number).toBeGreaterThanOrEqual(1);
    }
    // payload.md: node_modules と標準ライブラリは in_app: false
    const internal = frames.find((frame) => String(frame.filename).startsWith("node:"));
    if (internal) expect(internal.in_app).toBe(false);
  });

  test("frame 数は契約の上限で切る", async () => {
    let request: Request | undefined;
    const client = createNodeClient({
      dsn: "https://msk_example@ingest.example.test/1",
      environment: "production",
      batchSize: 1,
      maxRetries: 0,
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });
    const error = new Error("deep");
    error.stack = [
      "Error: deep",
      ...Array.from(
        { length: limits.frames_per_stacktrace + 50 },
        (_, i) => `    at fn${i} (/app/src/deep.js:${i + 1}:1)`,
      ),
    ].join("\n");
    await client.captureException(error);
    await client.close();

    const envelope = (await decodeGzipBody(request!)) as Envelope;
    const frames = (envelope.items[0]!.exception as { values: Array<{ stacktrace: { frames: unknown[] } }> })
      .values[0]!.stacktrace.frames;
    expect(frames).toHaveLength(limits.frames_per_stacktrace);
    expect(validate(envelope), describeErrors(validate)).toBe(true);
  });

  test("uncaught / unhandled の mechanism は schema の enum にある", async () => {
    const mechanismEnum = enumOf(
      (definition(schema, "mechanism").properties as Record<string, never>).type,
    );
    expect(mechanismEnum).toContain("onerror");
    expect(mechanismEnum).toContain("onunhandledrejection");
  });
});

function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (predicate(items[i]!)) return i;
  return -1;
}
