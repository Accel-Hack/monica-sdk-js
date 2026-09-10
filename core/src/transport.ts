import type {
  MonicaEnvelope,
  MonicaTransport,
  TransportDiagnostic,
  TransportDiagnosticHandler,
  TransportError,
  TransportIssue,
  TransportResult,
} from "./types.js";

export interface FetchTransportOptions {
  dsn: string;
  auth?: "public" | "secret";
  fetch?: FetchLike;
  maxRetries?: number;
  requestTimeoutMs?: number;
  /**
   * ingest が envelope を拒否したときの診断の受け取り先。既定は `console.warn` に
   * 1 行出す。`null` を渡すと何も出さない（結果の `issues` / `error` は残る）。
   *
   * 422 は payload を直せる情報なので既定で出す。ここが throw しても送信結果は
   * 変わらない。
   */
  onDiagnostic?: TransportDiagnosticHandler | null;
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * エラー body の読み込み上限。これを超えたら読むのをやめ、issues 無しとして
 * 従来どおり破棄する。ingest の 422 body は issues を数十件並べても収まる。
 */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export function createFetchTransport(options: FetchTransportOptions): MonicaTransport {
  const { endpoint, key } = parseDsn(options.dsn);
  const auth = options.auth ?? "secret";
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (!fetchImplementation) throw new Error("A fetch implementation is required");
  const onDiagnostic =
    options.onDiagnostic === undefined ? defaultDiagnosticHandler : options.onDiagnostic;
  const maxRetries = options.maxRetries ?? 5;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError("maxRetries must be a non-negative integer");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RangeError("requestTimeoutMs must be a positive integer");
  }

  // transport.json: 401 は drop_and_stop。鍵が失効した長寿命プロセスが、絶対に
  // 受理されない endpoint へ flushIntervalMs ごとに永久に POST し続けるのを止める。
  let stopped = false;

  return {
    async send(envelope, outerSignal): Promise<TransportResult> {
      if (stopped) return { accepted: false, status: 401, stop: true };
      const body = await gzipEnvelope(envelope);
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        const abort = () => controller.abort(outerSignal?.reason);
        outerSignal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        const candidate = timeout as unknown as { unref?: () => void };
        candidate.unref?.();
        try {
          const response = await fetchImplementation(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Encoding": "gzip",
              ...(auth === "secret"
                ? { Authorization: `Bearer ${key}` }
                : { "X-Monica-Key": key }),
            },
            body,
            signal: controller.signal,
          });
          if (response.ok) {
            discardBody(response);
            return { accepted: true, status: response.status };
          }
          if (response.status !== 429 && response.status < 500) {
            // ingest.md: 429 以外の 4xx は恒久的な失敗。破棄することは変えず、
            // 破棄する前に body を error.json として読む。422 の issues は payload を
            // 直すための情報で、読まなければ「送っているのに 1 件も届かない」状態が
            // 無言のまま続く。
            //
            // body の読み取りには request timeout を張り直す。header だけ返して body を
            // 閉じないピアに当たったとき、ここで待ち続けると send() が resolve せず、
            // client の sending が立ったまま以後の送信が止まってしまう。
            // （最初の timer は response 待ちのもので、ここで役目を終える）
            clearTimeout(timeout);
            const details = await readErrorDetails(response, requestTimeoutMs);
            // 422（payload を直せる情報）と 401（以後止めたこと）は既定で警告する。
            // どちらも 1 envelope につき 1 回で、401 は止めたあと POST しないので
            // 二度目は出ない。
            if (response.status === 422 || response.status === 401) {
              notify(onDiagnostic, { status: response.status, ...details });
            }
            // transport.json: 401 は drop_and_stop。この transport からは以後 POST しない。
            if (response.status === 401) stopped = true;
            return {
              accepted: false,
              status: response.status,
              ...details,
              ...(response.status === 401 ? { stop: true } : {}),
            };
          }
          if (attempt === maxRetries) {
            discardBody(response);
            return { accepted: false, status: response.status };
          }
          const retryAfter = response.status === 429
            ? parseRetryAfter(response.headers.get("Retry-After"))
            : undefined;
          // 読まない body を放置すると connection が pool に返らない
          discardBody(response);
          await delay(retryAfter ?? backoff(attempt), outerSignal);
        } catch {
          if (outerSignal?.aborted || attempt === maxRetries) return { accepted: false };
          await delay(backoff(attempt), outerSignal);
        } finally {
          clearTimeout(timeout);
          outerSignal?.removeEventListener("abort", abort);
        }
      }
      return { accepted: false };
    },
  };
}

interface ErrorDetails {
  issues?: TransportIssue[];
  error?: TransportError;
}

/** 読み取りを諦めたことを表す番兵。`undefined` は「読めなかった」と同じ扱い */
const GIVE_UP = Symbol("give up");

/**
 * 4xx のレスポンス body を error.json の形として読む。読めなければ欄を作らずに返す。
 * ここから例外を投げてはいけない: 送信結果（破棄）は body の読めなさに左右されない。
 */
async function readErrorDetails(response: Response, timeoutMs: number): Promise<ErrorDetails> {
  try {
    const text = await readCappedText(response, MAX_ERROR_BODY_BYTES, timeoutMs);
    if (text === undefined || text === "") return {};
    return parseErrorBody(text);
  } catch {
    return {};
  }
}

/**
 * body を上限まで読む。上限超過・timeout・読み取り失敗ではいずれも `undefined` を
 * 返し、読み終えていない body は cancel する（connection を pool に返すため）。
 *
 * `Content-Length` を信用せず実際に読んだ byte 数で判定する（chunked や
 * 嘘の header でも上限を守るため）。
 */
async function readCappedText(
  response: Response,
  limit: number,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  const stream = response.body;
  if (!stream) {
    // ReadableStream を持たない Response（テストの fake や一部 runtime）向けの経路。
    // ここでは上限まで読む手段が無いので、読み終えてから byte 数で捨てる
    const text = await withDeadline(response.text(), deadline);
    if (text === GIVE_UP) return undefined;
    return new TextEncoder().encode(text).byteLength > limit ? undefined : text;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await withDeadline(reader.read(), deadline);
      if (chunk === GIVE_UP) {
        // header だけ返して body を閉じないピア、または遅すぎる body
        await reader.cancel().catch(() => {});
        return undefined;
      }
      if (chunk.done) break;
      if (!chunk.value) continue;
      total += chunk.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * `deadline` までに解決しなければ `GIVE_UP` を返す。捨てる側の promise の rejection は
 * 飲む（unhandled rejection にしない）。
 */
function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | typeof GIVE_UP> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<typeof GIVE_UP>((resolve) => {
      timer = setTimeout(() => resolve(GIVE_UP), Math.max(0, deadline - Date.now()));
      const candidate = timer as unknown as { unref?: () => void };
      candidate.unref?.();
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * 読まない body を捨てる。undici は body を読み切るか cancel するまで connection を
 * pool に返さない。cancel の完了は待たない（送信結果はこれに左右されない）。
 */
function discardBody(response: Response): void {
  const body = response.body;
  if (!body || body.locked) return;
  void body.cancel().catch(() => {});
}

function parseErrorBody(text: string): ErrorDetails {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return {};
  const source = parsed.error;
  const details: ErrorDetails = {};
  if (typeof source.code === "string") {
    details.error = {
      code: source.code,
      message: typeof source.message === "string" ? source.message : "",
    };
  }
  if (Array.isArray(source.issues)) {
    // path / message が string でない要素は捨てる。1 件でも読めれば残りは使える。
    const issues = source.issues.filter(
      (issue): issue is TransportIssue =>
        isRecord(issue) && typeof issue.path === "string" && typeof issue.message === "string",
    );
    if (issues.length > 0) details.issues = issues;
  }
  return details;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function notify(handler: TransportDiagnosticHandler | null, details: ErrorDetails & {
  status: number;
}): void {
  if (!handler) return;
  const issues = details.issues ?? [];
  const diagnostic: TransportDiagnostic = {
    status: details.status,
    issues,
    ...(details.error ? { error: details.error } : {}),
    message: formatDiagnostic(details.status, details.error, issues),
  };
  try {
    handler(diagnostic);
  } catch {
    // 利用者のハンドラが throw しても送信結果は変えない。
  }
}

/**
 * 全 SDK で意味を揃えた 1 行。code が読めなかった場合は `unknown` を入れる。
 * envelope 本体・API key は含めない。
 */
function formatDiagnostic(
  status: number,
  error: TransportError | undefined,
  issues: TransportIssue[],
): string {
  const code = error?.code ?? "unknown";
  // 401 は payload の問題ではなく鍵の問題。直すべきことが違うので文面も分ける
  if (status === 401) {
    return `monica: ingest rejected the envelope with 401 (${code}); no further envelopes will be sent`;
  }
  const head = `monica: ingest rejected the envelope with ${status} (${code}): ${issues.length} issue(s)`;
  if (issues.length === 0) return head;
  return `${head}${issues.map((issue) => `; ${issue.path}: ${issue.message}`).join("")}`;
}

const defaultDiagnosticHandler: TransportDiagnosticHandler = (diagnostic) => {
  console.warn(diagnostic.message);
};

function parseDsn(dsn: string): { endpoint: string; key: string } {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new TypeError("dsn must be a valid URL");
  }
  const key = decodeURIComponent(url.username);
  if (!key) throw new TypeError("dsn must include an API key as the username");
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new TypeError("dsn must use https except for localhost");
  }
  url.username = "";
  url.password = "";
  url.pathname = "/v1/envelope";
  url.search = "";
  url.hash = "";
  return { endpoint: url.toString(), key };
}

async function gzipEnvelope(envelope: MonicaEnvelope): Promise<ArrayBuffer> {
  const source = new Blob([JSON.stringify(envelope)]).stream();
  return new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Math.min(Number(value) * 1_000, 60_000);
}

function backoff(attempt: number): number {
  const base = Math.min(1_000 * 2 ** attempt, 30_000);
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const candidate = timer as unknown as { unref?: () => void };
    candidate.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
