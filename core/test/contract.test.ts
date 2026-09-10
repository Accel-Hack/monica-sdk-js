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
  compileErrorValidator,
  decodeGzipBody,
  definition,
  describeErrors,
  enumOf,
  errorItemProperty,
  readEnvelopeSchema,
  readEnvelopeVectors,
  readLimits,
  type JsonObject,
} from "../../tooling/contract.js";
import {
  createCoreClient,
  createFetchTransport,
  type CaptureItemInput,
  type MonicaEnvelope,
  type MonicaLevel,
  type MonicaTransport,
  type TransportDiagnostic,
} from "../src/index.js";

const schema = await readEnvelopeSchema();
const limits = await readLimits();
const validate = await compileEnvelopeValidator();
const validateError = await compileErrorValidator();
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
 * ingest.md: `422` は「破棄する。`issues` の path を見て payload を直す」。
 * error.json はこの body のためだけにある schema なので、読まなければ SDK は
 * 契約の半分しか果たしていない。読んで警告し、結果に載せるところまでを固定する。
 */
describe("public contract: 4xx の error body（error.json）", () => {
  const envelope: MonicaEnvelope = {
    sdk: { name: "@ah-monica/core", version: "0.0.0-test" },
    sent_at: "2026-08-29T00:00:00.000Z",
    discarded: 0,
    items: [],
  };
  const dsn = "https://msk_secret_example@ingest.example.test/42";
  const invalidEnvelopeBody = {
    error: {
      code: "invalid_envelope",
      message: "The envelope does not match the MONICA schema",
      issues: [
        { path: "$.items[0].request.method", message: "Invalid type: Expected string" },
        { path: "$.items[1].level", message: "Invalid option: Expected one of ..." },
      ],
    },
  };

  /** status と body を固定で返す transport。`onDiagnostic` は既定のまま */
  function transportReturning(
    status: number,
    body: BodyInit | null,
    onDiagnostic?: ((diagnostic: TransportDiagnostic) => void) | null,
  ) {
    let attempts = 0;
    const transport = createFetchTransport({
      dsn,
      maxRetries: 3,
      ...(onDiagnostic !== undefined ? { onDiagnostic } : {}),
      fetch: async () => {
        attempts += 1;
        return new Response(body, { status });
      },
    });
    return { transport, attempts: () => attempts };
  }

  function capturingWarn(): { warned: string[]; restore: () => void } {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    };
    return { warned, restore: () => (console.warn = original) };
  }

  test("fixture が公開 schema（error.json）に適合している", () => {
    // 適合しない body で「読めた」を主張しないための土台
    expect(validateError(invalidEnvelopeBody), describeErrors(validateError)).toBe(true);
    expect(validateError({ error: { code: "invalid_envelope", message: "x" } })).toBe(true);
    // code / message は必須
    expect(validateError({ error: { message: "x" } })).toBe(false);
  });

  test("422 の issues の path が既定で console.warn に出る", async () => {
    const warn = capturingWarn();
    try {
      const { transport, attempts } = transportReturning(
        422,
        JSON.stringify(invalidEnvelopeBody),
      );
      const result = await transport.send(envelope);

      // 破棄は従来どおり。再送しない
      expect(result.accepted).toBe(false);
      expect(result.status).toBe(422);
      expect(attempts()).toBe(1);
      // 1 envelope につき 1 行
      expect(warn.warned).toHaveLength(1);
      const line = warn.warned[0]!;
      expect(line).toContain("monica: ingest rejected the envelope with 422 (invalid_envelope)");
      expect(line).toContain("2 issue(s)");
      expect(line).toContain("$.items[0].request.method");
      expect(line).toContain("$.items[1].level");
      // 秘密情報は出さない
      expect(line).not.toContain("msk_");
    } finally {
      warn.restore();
    }
  });

  test("送信結果から status / issues / error.code が取れる", async () => {
    const { transport } = transportReturning(422, JSON.stringify(invalidEnvelopeBody), null);
    expect(await transport.send(envelope)).toEqual({
      accepted: false,
      status: 422,
      issues: invalidEnvelopeBody.error.issues,
      error: {
        code: invalidEnvelopeBody.error.code,
        message: invalidEnvelopeBody.error.message,
      },
    });
  });

  test("issues が無い 422 でも 1 行だけ警告する", async () => {
    const warn = capturingWarn();
    try {
      const { transport } = transportReturning(
        422,
        JSON.stringify({ error: { code: "invalid_envelope", message: "nope" } }),
      );
      const result = await transport.send(envelope);
      expect(result).toEqual({
        accepted: false,
        status: 422,
        error: { code: "invalid_envelope", message: "nope" },
      });
      expect(warn.warned).toEqual([
        "monica: ingest rejected the envelope with 422 (invalid_envelope): 0 issue(s)",
      ]);
    } finally {
      warn.restore();
    }
  });

  test("body が読めなくても例外を投げず、従来どおり破棄で終わる", async () => {
    const oversized = JSON.stringify({
      error: {
        code: "invalid_envelope",
        message: "too big",
        // 上限（64 KiB）を確実に超える。読み切らずに諦める
        issues: Array.from({ length: 4_000 }, (_, index) => ({
          path: `$.items[${index}].request.method`,
          message: "Invalid type: Expected string",
        })),
      },
    });
    expect(oversized.length).toBeGreaterThan(64 * 1024);

    const bodies: Array<[string, BodyInit | null]> = [
      ["空 body", null],
      ["空文字", ""],
      ["非 JSON", "<html>502</html>"],
      ["JSON だが object でない", "[1,2,3]"],
      ["error が無い", JSON.stringify({ message: "nope" })],
      ["error が object でない", JSON.stringify({ error: "nope" })],
      ["code が string でない", JSON.stringify({ error: { code: 7, message: "nope" } })],
      ["上限超過", oversized],
    ];

    const warn = capturingWarn();
    try {
      for (const [label, body] of bodies) {
        const { transport, attempts } = transportReturning(422, body);
        // throw しないこと自体が assertion
        expect(await transport.send(envelope), label).toEqual({ accepted: false, status: 422 });
        expect(attempts(), label).toBe(1);
      }
      // 読めなくても「422 で破棄した」ことは伝える
      expect(warn.warned).toHaveLength(bodies.length);
      for (const line of warn.warned) {
        expect(line).toBe(
          "monica: ingest rejected the envelope with 422 (unknown): 0 issue(s)",
        );
      }
    } finally {
      warn.restore();
    }
  });

  test("issues の要素は path / message が string のものだけ残す", async () => {
    const { transport } = transportReturning(
      422,
      JSON.stringify({
        error: {
          code: "invalid_envelope",
          message: "mixed",
          issues: [
            { path: "$.items[0].level", message: "Invalid option" },
            { path: 1, message: "Invalid" },
            { path: "$.items[1].level" },
            "nope",
            null,
          ],
        },
      }),
      null,
    );
    const result = await transport.send(envelope);
    expect(result.issues).toEqual([{ path: "$.items[0].level", message: "Invalid option" }]);
  });

  test("onDiagnostic で警告を差し替えられ、null で無効化できる", async () => {
    const seen: TransportDiagnostic[] = [];
    const replaced = transportReturning(422, JSON.stringify(invalidEnvelopeBody), (diagnostic) => {
      seen.push(diagnostic);
    });
    await replaced.transport.send(envelope);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe(422);
    expect(seen[0]!.issues.map((issue) => issue.path)).toEqual([
      "$.items[0].request.method",
      "$.items[1].level",
    ]);
    expect(seen[0]!.error?.code).toBe("invalid_envelope");
    expect(seen[0]!.message).toContain("$.items[0].request.method");

    const warn = capturingWarn();
    try {
      const disabled = transportReturning(422, JSON.stringify(invalidEnvelopeBody), null);
      const result = await disabled.transport.send(envelope);
      expect(warn.warned).toEqual([]);
      // 無効化しても結果には載る
      expect(result.issues).toHaveLength(2);
    } finally {
      warn.restore();
    }
  });

  test("onDiagnostic が throw しても送信結果は変わらない", async () => {
    const { transport } = transportReturning(422, JSON.stringify(invalidEnvelopeBody), () => {
      throw new Error("handler exploded");
    });
    const result = await transport.send(envelope);
    expect(result.accepted).toBe(false);
    expect(result.status).toBe(422);
  });

  test("422 以外の 4xx は警告を出さず、破棄も再送しないまま変わらない", async () => {
    const warn = capturingWarn();
    try {
      for (const status of [400, 401, 404]) {
        const { transport, attempts } = transportReturning(
          status,
          JSON.stringify({ error: { code: "bad_request", message: "nope" } }),
        );
        const result = await transport.send(envelope);
        expect(result.accepted, `status ${status}`).toBe(false);
        expect(result.status, `status ${status}`).toBe(status);
        expect(attempts(), `status ${status}`).toBe(1);
        // 読んだ内容は結果には載せる（分岐は status で行う）
        expect(result.error, `status ${status}`).toEqual({ code: "bad_request", message: "nope" });
      }
      expect(warn.warned).toEqual([]);
    } finally {
      warn.restore();
    }
  });

  test("429 / 5xx の retry 挙動は変わらず、警告も出さない", async () => {
    const warn = capturingWarn();
    try {
      const statuses: number[] = [];
      const transport = createFetchTransport({
        dsn,
        maxRetries: 2,
        fetch: async () => {
          statuses.push(statuses.length);
          if (statuses.length === 1) {
            return new Response(JSON.stringify({ error: { code: "rate_limited", message: "x" } }), {
              status: 429,
              headers: { "Retry-After": "0" },
            });
          }
          if (statuses.length === 2) return new Response("boom", { status: 503 });
          return new Response(null, { status: 202 });
        },
      });
      expect(await transport.send(envelope)).toEqual({ accepted: true, status: 202 });
      expect(statuses).toHaveLength(3);
      expect(warn.warned).toEqual([]);
    } finally {
      warn.restore();
    }
  }, 10_000);

  test("retry の途中で 422 になっても警告は 1 回だけ", async () => {
    const warn = capturingWarn();
    try {
      let attempts = 0;
      const transport = createFetchTransport({
        dsn,
        maxRetries: 3,
        fetch: async () => {
          attempts += 1;
          if (attempts === 1) return new Response("boom", { status: 503 });
          return new Response(JSON.stringify(invalidEnvelopeBody), { status: 422 });
        },
      });
      expect((await transport.send(envelope)).status).toBe(422);
      expect(attempts).toBe(2);
      expect(warn.warned).toHaveLength(1);
    } finally {
      warn.restore();
    }
  }, 10_000);

  test("ReadableStream を持たない Response からも body を読む", async () => {
    // 一部 runtime / 自前 fetch は body stream を持たない Response を返す
    const fake = {
      ok: false,
      status: 422,
      body: null,
      headers: new Headers(),
      text: async () => JSON.stringify(invalidEnvelopeBody),
    } as unknown as Response;
    const transport = createFetchTransport({
      dsn,
      maxRetries: 0,
      onDiagnostic: null,
      fetch: async () => fake,
    });
    const result = await transport.send(envelope);
    expect(result.issues?.map((issue) => issue.path)).toEqual([
      "$.items[0].request.method",
      "$.items[1].level",
    ]);
  });

  test("flush() の戻り値から status と issues が取れる", async () => {
    const client = createCoreClient({
      environment: "production",
      transport: {
        async send() {
          return {
            accepted: false,
            status: 422,
            issues: invalidEnvelopeBody.error.issues,
            error: {
              code: invalidEnvelopeBody.error.code,
              message: invalidEnvelopeBody.error.message,
            },
          };
        },
      },
    });
    await client.capture({ type: "error", platform: "node", level: "error", message: "boom" });
    const result = await client.flush();

    expect(result.accepted).toBe(false);
    expect(result.discarded).toBe(1);
    expect(result.remaining).toBe(0);
    expect(result.status).toBe(422);
    expect(result.issues?.map((issue) => issue.path)).toEqual([
      "$.items[0].request.method",
      "$.items[1].level",
    ]);
    expect(result.error?.code).toBe("invalid_envelope");
  });

  test("受理された送信のあとの flush() には status / issues を載せない", async () => {
    const client = createCoreClient({
      environment: "production",
      transport: recordingTransport([]),
    });
    await client.capture({ type: "error", platform: "node", level: "error", message: "boom" });
    // 後方互換: 拒否が無ければ従来どおりの 3 欄だけ
    expect(await client.flush()).toEqual({ accepted: true, discarded: 0, remaining: 0 });
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

/**
 * adapter の guard は item を組む段階、beforeSend はその後。core.capture 自体も
 * 公開 export なので、どちらも adapter を通らない。envelope の 422 は envelope
 * 単位なので、1 件の item が同じ batch の無関係な event を全部道連れにする。
 */
describe("public contract: 契約が禁じる空配列は adapter の外でも載せない", () => {
  test("errorItem の minItems: 1 は fingerprint と exception.values だけ", () => {
    const errorItem = definition(schema, "errorItem");
    const constrained = Object.entries(errorItem.properties as Record<string, JsonObject>)
      .filter(([, rule]) => rule.minItems !== undefined)
      .map(([name]) => name);
    expect(constrained).toEqual(["fingerprint"]);
    expect(
      (definition(schema, "exception").properties as Record<string, JsonObject>).values!.minItems,
    ).toBe(1);
    // どちらも optional なので、落としても item は契約を満たす
    const required = errorItem.required as string[];
    expect(required).not.toContain("fingerprint");
    expect(required).not.toContain("exception");
  });

  test("beforeSend が空にした fingerprint / exception.values は載せない", async () => {
    const envelopes: MonicaEnvelope[] = [];
    const client = createCoreClient({
      transport: recordingTransport(envelopes),
      environment: "production",
      beforeSend(item) {
        // 「許可した fingerprint だけ残す」ような、ごく普通の beforeSend
        if (item.fingerprint) {
          item.fingerprint = item.fingerprint.filter((value) => value.startsWith("allowed:"));
        }
        if (item.exception) item.exception = { values: [] };
        return item;
      },
    });
    await client.capture({ ...fullItem(), fingerprint: ["denied:x"] });
    await client.flush();

    expect(envelopes).toHaveLength(1);
    expect(validate(envelopes[0]), describeErrors(validate)).toBe(true);
    const item = envelopes[0]!.items[0]!;
    expect(item).not.toHaveProperty("fingerprint");
    expect(item).not.toHaveProperty("exception");
  });

  test("core.capture を直接呼んだ場合も載せない", async () => {
    const envelopes: MonicaEnvelope[] = [];
    const client = createCoreClient({
      transport: recordingTransport(envelopes),
      environment: "production",
    });
    await client.capture({
      type: "error",
      platform: "node",
      level: "error",
      message: "boom",
      fingerprint: [],
      exception: { values: [] },
    });
    await client.flush();

    expect(validate(envelopes[0]), describeErrors(validate)).toBe(true);
    expect(envelopes[0]!.items[0]).not.toHaveProperty("fingerprint");
    expect(envelopes[0]!.items[0]).not.toHaveProperty("exception");
  });

  test("中身のある fingerprint / exception はそのまま載せる", async () => {
    const envelopes: MonicaEnvelope[] = [];
    const client = createCoreClient({
      transport: recordingTransport(envelopes),
      environment: "production",
    });
    await client.capture(fullItem());
    await client.flush();

    const item = envelopes[0]!.items[0]!;
    expect(item.fingerprint).toEqual(["custom", "group"]);
    expect((item.exception as { values: unknown[] }).values).toHaveLength(2);
  });

  test("空配列 1 件で、同じ batch の無関係な event が消えない", async () => {
    // 422 は envelope 単位。修正前は無関係な 4 件ごと捨てられていた
    const envelopes: MonicaEnvelope[] = [];
    const client = createCoreClient({
      transport: recordingTransport(envelopes),
      environment: "production",
      batchSize: 5,
      flushIntervalMs: 60_000,
    });
    for (const n of [1, 2, 3, 4]) {
      await client.capture({ type: "error", platform: "node", level: "error", message: `${n}` });
    }
    await client.capture({
      type: "error",
      platform: "node",
      level: "error",
      message: "empty fingerprint",
      fingerprint: [],
    });
    expect(await client.flush()).toEqual({ accepted: true, discarded: 0, remaining: 0 });

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.items).toHaveLength(5);
    expect(validate(envelopes[0]), describeErrors(validate)).toBe(true);
  });
});
