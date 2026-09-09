/**
 * Cloudflare adapter が線に載せる envelope を、vendoring した公開契約
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
import { createCloudflareClient } from "../src/index.js";

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

describe("public contract: @ah-monica/cloudflare", () => {
  test("捕捉した例外の envelope が schema を通る", async () => {
    let request: Request | undefined;
    const client = createCloudflareClient({
      dsn: "https://msk_example@ingest.example.test/1",
      environment: "production",
      release: "1.2.3",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });
    await client.captureException(new Error("boom", { cause: new RangeError("cause") }), {
      tags: { operation: "handle-request" },
      request: { method: "GET", url: "https://app.example" },
      user: { id: "u_1" },
      breadcrumbs: [{ category: "http", message: "GET /" }],
      contexts: { worker: { colo: "NRT" } },
      fingerprint: ["custom"],
    });
    await client.close();

    expect(request?.url).toBe("https://ingest.example.test/v1/envelope");
    expect(request?.headers.get("Authorization")).toBe("Bearer msk_example");
    expect(request?.headers.get("Content-Encoding")).toBe("gzip");
    const envelope = (await decodeGzipBody(request!)) as Envelope;
    expect(validate(envelope), describeErrors(validate)).toBe(true);
    expect(envelope.sdk).toEqual({ name: packageMetadata.name, version: packageMetadata.version });

    const item = envelope.items[0]!;
    for (const required of definition(schema, "errorItem").required as string[]) {
      expect(item, `item is missing ${required}`).toHaveProperty(required);
    }
    expect(enumOf(errorItemProperty(schema, "platform"))).toContain(item.platform as string);
    expect(item.platform).toBe("javascript");
    const values = (item.exception as { values: Array<{ type: string }> }).values;
    expect(values.map((value) => value.type)).toEqual(["Error", "RangeError"]);
  });

  test("captureMessage の envelope も schema を通る", async () => {
    let request: Request | undefined;
    const client = createCloudflareClient({
      dsn: "https://msk_example@ingest.example.test/1",
      environment: "production",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });
    await client.captureMessage("scheduled run finished", "info");
    await client.close();

    const envelope = (await decodeGzipBody(request!)) as Envelope;
    expect(validate(envelope), describeErrors(validate)).toBe(true);
    expect(enumOf(errorItemProperty(schema, "level"))).toContain(envelope.items[0]!.level as string);
  });

  test("空の fingerprint は載せない", async () => {
    // $defs.errorItem.properties.fingerprint は minItems: 1。payload.md も空配列にしないと書く
    expect(errorItemProperty(schema, "fingerprint").minItems).toBe(1);
    let request: Request | undefined;
    const client = createCloudflareClient({
      dsn: "https://msk_example@ingest.example.test/1",
      environment: "production",
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
});
