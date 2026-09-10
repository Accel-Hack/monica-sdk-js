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
  type JsonObject,
} from "../../tooling/contract.js";
import {
  createNodeClient,
  type MonicaNodeClient,
  type NodeClientOptions,
} from "../src/index.js";

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

async function envelopeOf(
  capture: (client: MonicaNodeClient) => void | Promise<void>,
): Promise<Envelope | undefined> {
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
  await capture(client);
  await client.close();
  return request ? ((await decodeGzipBody(request)) as Envelope) : undefined;
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

  test("値を持たない例外でも exception.values は空にならない", async () => {
    // envelope.json の $defs.exception.values は minItems: 1。空配列を出すと、同じ batch に
    // 載った他の event ごと envelope 全体が 422 で捨てられる
    const minItems = (definition(schema, "exception").properties as Record<string, JsonObject>)
      .values!.minItems as number;
    for (const thrown of [null, undefined]) {
      const envelope = await envelopeOf((client) => void client.captureException(thrown));
      expect(envelope, `captureException(${String(thrown)}) sent nothing`).toBeDefined();
      expect(validate(envelope), describeErrors(validate)).toBe(true);
      const values = (envelope!.items[0]!.exception as { values: unknown[] }).values;
      expect(values.length).toBeGreaterThanOrEqual(minItems);
    }
  });

  test("素の Promise.reject() を拾った unhandledRejection も schema を通る", async () => {
    // reason が undefined でも envelope は組めていなければならない
    const envelope = await envelopeOf((client) => {
      const uninstall = client.installProcessHooks({ unhandledRejection: true });
      try {
        // 実際の素の Promise.reject() が runtime から渡す形をそのまま再現する
        (process as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit(
          "unhandledRejection",
          undefined,
          Promise.resolve(),
        );
      } finally {
        uninstall();
      }
    });
    expect(envelope).toBeDefined();
    expect(validate(envelope), describeErrors(validate)).toBe(true);
    const values = (envelope!.items[0]!.exception as { values: Array<{ mechanism: { type: string } }> })
      .values;
    expect(values.length).toBeGreaterThan(0);
    expect(values[0]!.mechanism.type).toBe("onunhandledrejection");
  });

  test("空の fingerprint は載せない", async () => {
    // $defs.errorItem.properties.fingerprint は minItems: 1。payload.md も空配列にしないと書く
    const fingerprint = errorItemProperty(schema, "fingerprint");
    expect(fingerprint.minItems).toBe(1);
    const envelope = await envelopeOf(
      (client) => void client.captureException(new Error("boom"), { fingerprint: [] }),
    );
    expect(envelope).toBeDefined();
    expect(validate(envelope), describeErrors(validate)).toBe(true);
    expect(envelope!.items[0]).not.toHaveProperty("fingerprint");
  });

  test("property が throw する Error でも落とさず、契約どおりの envelope を出す", async () => {
    // observability が host application を落としてはならない。message getter が throw
    // すると、captureException が呼び出し元へ throw し、process hook の listener から
    // 抜けて uncaughtException になり Node は既定でプロセスを落とす。
    // 型が違う name / message（number など）も、value: string / type: minLength 1 を破る
    class Hostile extends Error {
      override get message(): string {
        throw new Error("message getter exploded");
      }
      override get stack(): string {
        throw new Error("stack getter exploded");
      }
      get cause(): unknown {
        throw new Error("cause getter exploded");
      }
    }
    const wrongTypes = new Error("boom");
    Object.assign(wrongTypes, { name: 42, message: { toString: () => "not a string" } });

    for (const thrown of [new Hostile(), wrongTypes]) {
      // getter が throw すれば、この await 自体が落ちる
      const envelope = await envelopeOf((client) => void client.captureException(thrown));
      expect(envelope).toBeDefined();
      expect(validate(envelope), describeErrors(validate)).toBe(true);
      const value = (envelope!.items[0]!.exception as { values: Array<Record<string, unknown>> })
        .values[0]!;
      expect(typeof value.type).toBe("string");
      expect((value.type as string).length).toBeGreaterThanOrEqual(1);
      expect(typeof value.value).toBe("string");
    }
  });

  test("property が throw する Error は process hook の listener から抜けない", () => {
    class Hostile extends Error {
      override get message(): string {
        throw new Error("message getter exploded");
      }
    }
    const client = createNodeClient({
      dsn: "https://msk_example@ingest.example.test/1",
      environment: "production",
      fetch: async () => new Response(null, { status: 202 }),
    });
    const uninstall = client.installProcessHooks({ unhandledRejection: true });
    const emit = (event: string, ...args: unknown[]) =>
      (process as unknown as { emit(e: string, ...a: unknown[]): boolean }).emit(event, ...args);
    try {
      // listener から throw が抜けると Node では uncaughtException になる
      expect(() => emit("unhandledRejection", new Hostile(), Promise.resolve())).not.toThrow();
      expect(() => emit("uncaughtExceptionMonitor", new Hostile())).not.toThrow();
    } finally {
      uninstall();
      void client.close();
    }
  });
});

function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (predicate(items[i]!)) return i;
  return -1;
}

/**
 * adapter は `createFetchTransport` を内側で組むので、利用者が transport を
 * 触らなくても 422 の診断が既定で出ることを固定する（ingest.md の 422）。
 */
describe("public contract: 422 の診断は adapter からも既定で出る", () => {
  const body = JSON.stringify({
    error: {
      code: "invalid_envelope",
      message: "The envelope does not match the MONICA schema",
      issues: [{ path: "$.items[0].request.method", message: "Invalid type: Expected string" }],
    },
  });

  function clientReturning422(onDiagnostic?: NodeClientOptions["onDiagnostic"]) {
    return createNodeClient({
      dsn: "https://msk_example@ingest.example.test/1",
      environment: "production",
      maxRetries: 0,
      ...(onDiagnostic !== undefined ? { onDiagnostic } : {}),
      fetch: async () => new Response(body, { status: 422 }),
    });
  }

  test("既定で console.warn に issues の path が出て、flush からも取れる", async () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args.map(String).join(" "));
    try {
      const client = clientReturning422();
      await client.captureMessage("boom");
      const result = await client.close();

      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("422 (invalid_envelope)");
      expect(warned[0]).toContain("$.items[0].request.method");
      expect(warned[0]).not.toContain("msk_");
      expect(result.status).toBe(422);
      expect(result.issues).toEqual([
        { path: "$.items[0].request.method", message: "Invalid type: Expected string" },
      ]);
      expect(result.error?.code).toBe("invalid_envelope");
      // 422 は破棄。捨てた分として勘定する
      expect(result.discarded).toBe(1);
      expect(result.remaining).toBe(0);
    } finally {
      console.warn = original;
    }
  });

  test("onDiagnostic を渡すと差し替わり、null で無効化できる", async () => {
    const seen: string[] = [];
    const replaced = clientReturning422((diagnostic) => seen.push(diagnostic.message));
    await replaced.captureMessage("boom");
    await replaced.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("$.items[0].request.method");

    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args.map(String).join(" "));
    try {
      const disabled = clientReturning422(null);
      await disabled.captureMessage("boom");
      const result = await disabled.close();
      expect(warned).toEqual([]);
      // 無効化しても結果には載る
      expect(result.issues).toHaveLength(1);
    } finally {
      console.warn = original;
    }
  });
});
