/**
 * Next.js adapter（client / server）が線に載せる envelope を、vendoring した公開契約
 * （spec/v1/envelope.json）に照らす。
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
} from "../../tooling/contract.js";
import { createNextClient } from "../src/client/client.js";
import { createNextServerClient } from "../src/server/client.js";

const schema = await readEnvelopeSchema();
const validate = await compileEnvelopeValidator();
const packageMetadata = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  name: string;
  version: string;
};

interface Envelope {
  sdk: { name: string; version: string };
  items: Array<Record<string, unknown>>;
}

describe("public contract: @ah-monica/next", () => {
  test("client adapter は public key を X-Monica-Key で送り、envelope が schema を通る", async () => {
    let request: Request | undefined;
    const client = createNextClient({
      dsn: "https://mpk_example@ingest.example.test/1",
      environment: "production",
      release: "1.2.3",
      batchSize: 1,
      maxRetries: 0,
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });
    client.setUser({ id: "u_1" });
    client.addBreadcrumb({ category: "navigation", message: "/checkout" });
    await client.captureException(new Error("boom"), {
      tags: { page: "checkout" },
      contexts: { next: { digest: "abc" } },
    });
    await client.close();

    expect(request?.url).toBe("https://ingest.example.test/v1/envelope");
    expect(request?.headers.get("X-Monica-Key")).toBe("mpk_example");
    expect(request?.headers.has("Authorization")).toBe(false);
    const envelope = (await decodeGzipBody(request!)) as Envelope;
    expect(validate(envelope), describeErrors(validate)).toBe(true);
    expect(envelope.sdk).toEqual({ name: packageMetadata.name, version: packageMetadata.version });
    const item = envelope.items[0]!;
    for (const required of definition(schema, "errorItem").required as string[]) {
      expect(item, `item is missing ${required}`).toHaveProperty(required);
    }
    expect(enumOf(errorItemProperty(schema, "platform"))).toContain(item.platform as string);
    expect(item.platform).toBe("javascript");
  });

  test("server adapter の onRequestError の envelope が schema を通る", async () => {
    let request: Request | undefined;
    const server = createNextServerClient({
      dsn: "https://msk_example@ingest.example.test/1",
      environment: "production",
      batchSize: 1,
      maxRetries: 0,
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });
    await server.onRequestError(
      new Error("render failed"),
      { path: "/users/1", method: "GET", headers: { cookie: "session=secret" } },
      { routerKind: "App Router", routePath: "/users/[id]", routeType: "render" },
    );
    await server.close();

    expect(request?.headers.get("Authorization")).toBe("Bearer msk_example");
    const envelope = (await decodeGzipBody(request!)) as Envelope;
    expect(validate(envelope), describeErrors(validate)).toBe(true);
    const item = envelope.items[0]!;
    expect(item.platform).toBe("node");
    // payload.md: tags は文字列だけ。route template は tags、構造は contexts
    for (const value of Object.values(item.tags as Record<string, unknown>)) {
      expect(typeof value).toBe("string");
    }
    expect((item.contexts as { next: Record<string, string> }).next.routePath).toBe("/users/[id]");
    expect(JSON.stringify(item)).not.toContain("session=secret");
  });

  test("client adapter は空の fingerprint を載せない", async () => {
    // $defs.errorItem.properties.fingerprint は minItems: 1。payload.md も空配列にしないと書く
    expect(errorItemProperty(schema, "fingerprint").minItems).toBe(1);
    let request: Request | undefined;
    const client = createNextClient({
      dsn: "https://mpk_example@ingest.example.test/1",
      environment: "production",
      batchSize: 1,
      maxRetries: 0,
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });
    await client.captureException(new Error("boom"), { fingerprint: [] });
    await client.close();

    const envelope = (await decodeGzipBody(request!)) as Envelope;
    expect(validate(envelope), describeErrors(validate)).toBe(true);
    expect(envelope.items[0]).not.toHaveProperty("fingerprint");
  });

  test("サブリソースの読み込み失敗は error として送らない", async () => {
    // 壊れた <img> / <script> / <link> の読み込み失敗は、ErrorEvent ではなく
    // bubbles: false で target が要素の Event。捕捉すると画像 1 枚で発生ごとに
    // ingest へ飛び、中身は "Unknown global error" だけの 1 issue になる。
    // Chrome での実測では、この Event が window に届くのは capture: true で
    // 登録した listener だけなので、SDK が今登録している bubble phase には
    // 元々届かない。phase が変わっても捕捉しないことをここで固定する。
    const listeners = new Map<string, EventListener>();
    const originalAddEventListener = globalThis.addEventListener;
    const originalRemoveEventListener = globalThis.removeEventListener;
    globalThis.addEventListener = ((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }) as typeof globalThis.addEventListener;
    globalThis.removeEventListener = ((type: string) => {
      listeners.delete(type);
    }) as typeof globalThis.removeEventListener;

    const requests: Request[] = [];
    const client = createNextClient({
      dsn: "https://mpk_example@ingest.example.test/1",
      environment: "production",
      batchSize: 1,
      maxRetries: 0,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 202 });
      },
    });
    try {
      client.installGlobalHandlers();
      const onError = listeners.get("error")!;
      // <img src="broken.png"> の読み込み失敗が bubble してくる形
      onError({
        type: "error",
        target: { tagName: "IMG", src: "https://app.example/broken.png" },
      } as unknown as Event);
      await client.flush();
      expect(requests).toHaveLength(0);

      // 本物の uncaught error は今までどおり送る
      onError(
        new ErrorEvent("error", { message: "boom", error: new Error("boom") }),
      );
      await client.flush();
      expect(requests).toHaveLength(1);
      const envelope = (await decodeGzipBody(requests[0]!)) as Envelope;
      expect(validate(envelope), describeErrors(validate)).toBe(true);
      const values = (envelope.items[0]!.exception as { values: Array<{ mechanism: { type: string } }> })
        .values;
      expect(values[0]!.mechanism.type).toBe("onerror");

      // ErrorEvent を持たない runtime では target で絞る
      const errorEvent = globalThis.ErrorEvent;
      delete (globalThis as Partial<typeof globalThis>).ErrorEvent;
      try {
        onError({ type: "error", target: { tagName: "IMG" } } as unknown as Event);
        await client.flush();
        expect(requests).toHaveLength(1);
        onError({ type: "error", target: globalThis, message: "boom" } as unknown as Event);
        await client.flush();
        expect(requests).toHaveLength(2);
      } finally {
        globalThis.ErrorEvent = errorEvent;
      }
    } finally {
      await client.close();
      globalThis.addEventListener = originalAddEventListener;
      globalThis.removeEventListener = originalRemoveEventListener;
    }
  });
});
