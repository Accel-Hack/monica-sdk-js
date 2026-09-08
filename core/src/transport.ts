import type { MonicaEnvelope, MonicaTransport, TransportResult } from "./types.js";

export interface FetchTransportOptions {
  dsn: string;
  auth?: "public" | "secret";
  fetch?: FetchLike;
  maxRetries?: number;
  requestTimeoutMs?: number;
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function createFetchTransport(options: FetchTransportOptions): MonicaTransport {
  const { endpoint, key } = parseDsn(options.dsn);
  const auth = options.auth ?? "secret";
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (!fetchImplementation) throw new Error("A fetch implementation is required");
  const maxRetries = options.maxRetries ?? 5;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError("maxRetries must be a non-negative integer");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RangeError("requestTimeoutMs must be a positive integer");
  }

  return {
    async send(envelope, outerSignal): Promise<TransportResult> {
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
          if (response.ok) return { accepted: true, status: response.status };
          if (response.status !== 429 && response.status < 500) {
            return { accepted: false, status: response.status };
          }
          if (attempt === maxRetries) return { accepted: false, status: response.status };
          const retryAfter = response.status === 429
            ? parseRetryAfter(response.headers.get("Retry-After"))
            : undefined;
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
