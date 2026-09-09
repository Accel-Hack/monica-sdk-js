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
});
