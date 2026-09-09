/**
 * vendoring した公開契約バンドル（spec/v1/）に対する契約テスト。
 *
 * - envelope.json（Ingest が実際に走らせる検証器から生成された JSON Schema）に、
 *   この SDK が組む envelope が通ること
 * - test vectors の判定が公開 schema と一致すること
 * - limits.json の上限を SDK が守ること
 * - transport が ingest.md に書かれた叩き方をすること
 *
 * 上限・enum・pattern はすべて schema から読む。契約が締まる方向に変わると、
 * 黙ってズレるのではなくこのテストが落ちる。
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
  readEnvelopeVectors,
  readLimits,
} from "../../tooling/contract.js";
import {
  createCoreClient,
  createFetchTransport,
  type CaptureItemInput,
  type MonicaEnvelope,
  type MonicaLevel,
  type MonicaTransport,
} from "../src/index.js";

const schema = await readEnvelopeSchema();
const limits = await readLimits();
const validate = await compileEnvelopeValidator();
const packageMetadata = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  name: string;
  version: string;
};

function recordingTransport(envelopes: MonicaEnvelope[]): MonicaTransport {
  return {
    async send(envelope) {
      envelopes.push(envelope);
      return { accepted: true, status: 202 };
    },
  };
}

/** SDK が埋められる欄をすべて埋めた error item */
function fullItem(): CaptureItemInput {
  return {
    type: "error",
    platform: "node",
    level: "error",
    message: "boom",
    server_name: "web-1",
    exception: {
      values: [
        {
          type: "Error",
          value: "boom",
          stacktrace: {
            frames: [
              { filename: "app/server.ts", function: "main", lineno: 3, colno: 1, in_app: true },
              { filename: "node:internal", function: "run", lineno: 10, colno: 5, in_app: false },
            ],
          },
          mechanism: { type: "generic", handled: true },
        },
        { type: "TypeError", value: "cause", mechanism: { type: "generic", handled: true } },
      ],
    },
    breadcrumbs: [
      {
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "default",
        category: "http",
        message: "GET /",
        level: "info",
        data: { status: 200 },
      },
    ],
    request: { url: "https://app.example/", method: "GET", headers: { accept: "*/*" } },
    user: { id: "u_1", email: "person@example.test", ip: "203.0.113.1" },
    tags: { component: "server" },
    contexts: { runtime: { name: "node", version: "22" } },
    fingerprint: ["custom", "group"],
  };
}

describe("public contract: envelope schema", () => {
  test("test vectors の判定が公開 schema と一致する", async () => {
    const vectors = await readEnvelopeVectors();
    // vectors が読めていないのに通る、を防ぐ
    expect(vectors.length).toBeGreaterThan(10);
    expect(vectors.some((vector) => vector.valid)).toBe(true);
    expect(vectors.some((vector) => !vector.valid)).toBe(true);

    for (const vector of vectors) {
      // schema_rejects が無ければ「MONICA が拒否する = schema が拒否する」。
      // false は「schema は通るが MONICA は拒否する」（schema は形の検査まで）
      const schemaRejects = vector.schema_rejects ?? !vector.valid;
      const accepted = validate(vector.envelope);
      expect(accepted, `${vector.file}: ${vector.description} ${describeErrors(validate)}`).toBe(
        !schemaRejects,
      );
    }
  });

  test("必須項目だけの envelope が schema を通る", async () => {
    const envelopes: MonicaEnvelope[] = [];
    const client = createCoreClient({
      transport: recordingTransport(envelopes),
      environment: "production",
    });
    await client.capture({ type: "error", platform: "node", level: "error" });
    await client.flush();

    expect(envelopes).toHaveLength(1);
    expect(validate(envelopes[0]), describeErrors(validate)).toBe(true);
  });

  test("全ての欄を埋めた envelope が schema を通る", async () => {
    const envelopes: MonicaEnvelope[] = [];
    const client = createCoreClient({
      transport: recordingTransport(envelopes),
      environment: "production",
      release: "1.2.3",
    });
    await client.capture(fullItem());
    await client.flush();

    expect(envelopes).toHaveLength(1);
    expect(validate(envelopes[0]), describeErrors(validate)).toBe(true);
    const item = envelopes[0]?.items[0];
    expect(item?.release).toBe("1.2.3");
    expect(item?.fingerprint).toEqual(["custom", "group"]);
  });

  test("SDK が既定で名乗る sdk.name / sdk.version は package のもの", async () => {
    const envelopes: MonicaEnvelope[] = [];
    const client = createCoreClient({
      transport: recordingTransport(envelopes),
      environment: "production",
    });
    await client.capture({ type: "error", platform: "node", level: "error" });
    await client.flush();

    // ingest.md: sdk.name は配布 registry の package 名。空文字にしない
    const sdk = definition(schema, "sdk");
    const nameRule = (sdk.properties as Record<string, { minLength?: number }>).name;
    expect(envelopes[0]?.sdk).toEqual({
      name: packageMetadata.name,
      version: packageMetadata.version,
    });
    expect(envelopes[0]?.sdk.name.length).toBeGreaterThanOrEqual(nameRule.minLength ?? 1);
  });

  test("event_id は schema の pattern に、timestamp は RFC 3339 に従う", async () => {
    const envelopes: MonicaEnvelope[] = [];
    const client = createCoreClient({
      transport: recordingTransport(envelopes),
      environment: "production",
    });
    await client.capture({ type: "error", platform: "node", level: "error" });
    await client.flush();

    const item = envelopes[0]?.items[0];
    const pattern = new RegExp(errorItemProperty(schema, "event_id").pattern as string);
    expect(item?.event_id).toMatch(pattern);
    // payload.md: timestamp と sent_at は timezone 付きの RFC 3339。schema は string までしか
    // 表現しないので、ここで実際に組んだ値を見る
    const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
    expect(item?.timestamp).toMatch(rfc3339);
    expect(envelopes[0]?.sent_at).toMatch(rfc3339);
  });

  test("型が許す level / platform / mechanism.type は schema の enum に含まれる", () => {
    const levels: MonicaLevel[] = ["fatal", "error", "warning", "info", "debug"];
    const levelEnum = enumOf(errorItemProperty(schema, "level"));
    for (const level of levels) expect(levelEnum).toContain(level);

    const platformEnum = enumOf(errorItemProperty(schema, "platform"));
    for (const platform of ["javascript", "node", "java", "php"]) {
      expect(platformEnum).toContain(platform);
    }

    const mechanism = definition(schema, "mechanism");
    const mechanismEnum = enumOf((mechanism.properties as Record<string, never>).type);
    for (const type of ["onerror", "onunhandledrejection", "generic"]) {
      expect(mechanismEnum).toContain(type);
    }
  });

  test("environment の長さの上限は schema と同じ", () => {
    const environment = errorItemProperty(schema, "environment");
    const maxLength = environment.maxLength as number;
    const minLength = environment.minLength as number;
    expect(minLength).toBeGreaterThanOrEqual(1);

    const transport = recordingTransport([]);
    expect(() =>
      createCoreClient({ transport, environment: "x".repeat(maxLength) }),
    ).not.toThrow();
    expect(() =>
      createCoreClient({ transport, environment: "x".repeat(maxLength + 1) }),
    ).toThrow(RangeError);
    expect(() => createCoreClient({ transport, environment: "" })).toThrow(TypeError);
  });
});

describe("public contract: limits", () => {
  test("envelope あたりの item 数は limits.json を超えない", async () => {
    const envelopes: MonicaEnvelope[] = [];
    const total = limits.items_per_envelope * 2 + 5;
    const client = createCoreClient({
      transport: recordingTransport(envelopes),
      environment: "production",
      maxQueueSize: total,
      // 上限より大きな batchSize を頼んでも、契約の上限に丸められること
      batchSize: limits.items_per_envelope * 10,
      flushIntervalMs: 60_000,
    });
    for (let i = 0; i < total; i += 1) {
      await client.capture({ type: "error", platform: "node", level: "error", message: `${i}` });
    }
    await client.flush();

    expect(envelopes.length).toBeGreaterThan(1);
    for (const envelope of envelopes) {
      expect(envelope.items.length).toBeLessThanOrEqual(limits.items_per_envelope);
      expect(validate(envelope), describeErrors(validate)).toBe(true);
    }
    expect(envelopes.reduce((sum, envelope) => sum + envelope.items.length, 0)).toBe(total);
    // schema 側の maxItems と limits.json が同じ値を言っていること
    const items = (schema.properties as Record<string, { maxItems?: number }>).items;
    expect(items.maxItems).toBe(limits.items_per_envelope);
  });

  test("gzip 後の上限を超えることが確実な item は送らずに捨てる", async () => {
    let sends = 0;
    const client = createCoreClient({
      environment: "production",
      transport: {
        async send() {
          sends += 1;
          return { accepted: true };
        },
      },
    });
    // JSON の時点で gzip 後の上限を超えている item は、圧縮しても入らない
    await client.capture({
      type: "error",
      platform: "node",
      level: "error",
      message: "x".repeat(limits.envelope_gzip_bytes + 1),
    });
    expect(await client.flush()).toEqual({ accepted: false, discarded: 1, remaining: 0 });
    expect(sends).toBe(0);
  });

  test("frame の上限は schema と limits.json が同じ値を言う", () => {
    const exceptionValue = definition(schema, "exceptionValue");
    const stacktrace = (exceptionValue.properties as Record<string, Record<string, unknown>>)
      .stacktrace;
    const frames = (stacktrace.properties as Record<string, { maxItems?: number }>).frames;
    expect(frames.maxItems).toBe(limits.frames_per_stacktrace);
  });
});

describe("public contract: ingest HTTP", () => {
  const envelope: MonicaEnvelope = {
    sdk: { name: "@ah-monica/core", version: "0.0.0-test" },
    sent_at: "2026-08-29T00:00:00.000Z",
    discarded: 0,
    items: [],
  };

  test("POST /v1/envelope に gzip した JSON を 1 通送る（secret key）", async () => {
    let request: Request | undefined;
    const transport = createFetchTransport({
      dsn: "https://msk_example@ingest.example.test/42?x=1#frag",
      maxRetries: 0,
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });

    expect(await transport.send(envelope)).toEqual({ accepted: true, status: 202 });
    // ingest.md: 送信先は DSN の origin + /v1/envelope。パス・クエリ・フラグメントは捨てる
    expect(request?.url).toBe("https://ingest.example.test/v1/envelope");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("Content-Type")).toBe("application/json");
    expect(request?.headers.get("Content-Encoding")).toBe("gzip");
    expect(request?.headers.get("Authorization")).toBe("Bearer msk_example");
    expect(request?.headers.has("X-Monica-Key")).toBe(false);
    expect(await decodeGzipBody(request!)).toEqual(envelope);
    expect(validate(envelope), describeErrors(validate)).toBe(true);
  });

  test("public key は X-Monica-Key で送る", async () => {
    let request: Request | undefined;
    const transport = createFetchTransport({
      dsn: "https://mpk_example@ingest.example.test/42",
      auth: "public",
      maxRetries: 0,
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });

    await transport.send(envelope);
    expect(request?.headers.get("X-Monica-Key")).toBe("mpk_example");
    expect(request?.headers.has("Authorization")).toBe(false);
  });

  test("https 以外は localhost と 127.0.0.1 だけ許す", () => {
    expect(() => createFetchTransport({ dsn: "http://k@localhost:8787/1" })).not.toThrow();
    expect(() => createFetchTransport({ dsn: "http://k@127.0.0.1:8787/1" })).not.toThrow();
    expect(() => createFetchTransport({ dsn: "http://k@ingest.example.test/1" })).toThrow(
      TypeError,
    );
    // 鍵は user info。password は使わない
    expect(() => createFetchTransport({ dsn: "https://ingest.example.test/1" })).toThrow(
      TypeError,
    );
  });

  test("400 / 401 / 422 は再送しない", async () => {
    for (const status of [400, 401, 422]) {
      let attempts = 0;
      const transport = createFetchTransport({
        dsn: "https://msk_example@ingest.example.test/42",
        maxRetries: 3,
        fetch: async () => {
          attempts += 1;
          return new Response(null, { status });
        },
      });
      expect(await transport.send(envelope)).toEqual({ accepted: false, status });
      expect(attempts, `status ${status}`).toBe(1);
    }
  });

  test("429 は Retry-After（整数秒）を待って再送し、5xx は backoff して再送する", async () => {
    const statuses: number[] = [];
    const transport = createFetchTransport({
      dsn: "https://msk_example@ingest.example.test/42",
      maxRetries: 2,
      fetch: async () => {
        statuses.push(statuses.length);
        if (statuses.length === 1) {
          return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
        }
        if (statuses.length === 2) return new Response(null, { status: 503 });
        return new Response(null, { status: 202 });
      },
    });

    const started = Date.now();
    expect(await transport.send(envelope)).toEqual({ accepted: true, status: 202 });
    expect(statuses).toHaveLength(3);
    // backoff は min(1000 * 2^attempt, 30000) に 50〜100% の jitter。attempt=1 なら 1〜2 秒
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  }, 10_000);

  test("再送回数には上限があり、尽きたら envelope を捨てる", async () => {
    let attempts = 0;
    const transport = createFetchTransport({
      dsn: "https://msk_example@ingest.example.test/42",
      maxRetries: 1,
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
      },
    });
    expect(await transport.send(envelope)).toEqual({ accepted: false, status: 429 });
    expect(attempts).toBe(2);
  });
});

/**
 * ingest.md / README の前提: observability が host application を落としてはならない。
 * flush timer と capture の fatal / batch-full 経路は `void sendBatch()` で promise を
 * 捨てるので、sendBatch が reject すると unhandled rejection になり、Node は既定で
 * プロセスを落とす。
 */
describe("public contract: 利用者が渡した関数が throw しても落ちない", () => {
  const item: CaptureItemInput = {
    type: "error",
    platform: "node",
    level: "fatal",
    // now が throw する場合を試すため、capture 側では now を呼ばせない
    timestamp: "2026-08-29T00:00:00.000Z",
  };

  async function withoutUnhandledRejections(
    body: () => Promise<void>,
  ): Promise<void> {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await body();
      // unhandled rejection の判定は microtask を流し切った後に行われる
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rejections.map(String)).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }

  test("transport.send が同期的に throw しても捨てた分に勘定して続ける", async () => {
    await withoutUnhandledRejections(async () => {
      const client = createCoreClient({
        environment: "production",
        transport: {
          send() {
            throw new Error("transport exploded");
          },
        },
      });
      // level: "fatal" は capture の中で void sendBatch() に入る経路
      await client.capture(item);
      const result = await client.flush();
      expect(result.discarded).toBe(1);
      expect(result.remaining).toBe(0);
    });
  });

  test("now が同期的に throw しても捨てた分に勘定して続ける", async () => {
    await withoutUnhandledRejections(async () => {
      const client = createCoreClient({
        environment: "production",
        transport: recordingTransport([]),
        now: () => {
          throw new Error("clock exploded");
        },
      });
      await client.capture(item);
      const result = await client.flush();
      expect(result.discarded).toBe(1);
      expect(result.remaining).toBe(0);
    });
  });
});
