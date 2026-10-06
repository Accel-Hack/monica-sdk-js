import {
  createCoreClient,
  createFetchTransport,
  type CaptureHint,
  type CaptureItemInput,
  type MonicaExceptionValue,
  type MonicaFrame,
  type MonicaRequest,
} from "@ah-monica/core";
import { SDK_VERSION } from "./version.js";
import type {
  CloudflareCaptureContext,
  CloudflareClientOptions,
  MonicaCloudflareClient,
  WaitUntilContext,
} from "./types.js";

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_CAUSE_DEPTH = 10;
const DEFAULT_MAX_STACK_FRAMES = 200;

// client は request ごとに作られるので、start を送ったかは isolate に 1 つ持つ。
// 判定の前に印を付けるので、並行する request でも isolate ごとに 1 回になる
// （dsn と environment が違えば別に数える）
const startedInIsolate = new Set<string>();

export function createCloudflareClient(
  options: CloudflareClientOptions,
): MonicaCloudflareClient {
  assertPositiveInteger("flushTimeoutMs", options.flushTimeoutMs);
  assertPositiveInteger("maxCauseDepth", options.maxCauseDepth);
  assertPositiveInteger("maxStackFrames", options.maxStackFrames);
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const maxCauseDepth = options.maxCauseDepth ?? DEFAULT_MAX_CAUSE_DEPTH;
  const maxStackFrames = options.maxStackFrames ?? DEFAULT_MAX_STACK_FRAMES;
  const presenceKey = `${options.dsn ?? ""}\n${options.environment}`;
  const core = createCoreClient({
    transport: createFetchTransport({
      dsn: options.dsn,
      auth: "secret",
      fetch: options.fetch,
      maxRetries: options.maxRetries ?? 0,
      requestTimeoutMs: options.requestTimeoutMs,
      onDiagnostic: options.onDiagnostic,
    }),
    environment: options.environment,
    release: options.release,
    sampleRate: options.sampleRate,
    beforeSend: options.beforeSend,
    sdk: { name: "@ah-monica/cloudflare", version: SDK_VERSION },
    presence: { platform: "cloudflare" },
  });

  /**
   * Workers にはタイマーが無く、global scope では fetch できない。生成時ではなく最初の
   * flush / capture の呼び出し（request の中）で start を送る。送信中の分は flush() が
   * 待つので、それを waitUntil に載せれば handler の後まで生きる。
   */
  function startOnce(): void {
    if (startedInIsolate.has(presenceKey)) return;
    startedInIsolate.add(presenceKey);
    void core.checkPresence("start");
  }

  function flush(timeoutMs?: number) {
    startOnce();
    return core.flush(timeoutMs);
  }

  async function captureAndFlush(
    input: CaptureItemInput,
    hint?: CaptureHint,
  ): Promise<string | null> {
    try {
      startOnce();
      const eventId = await core.capture(input, hint);
      // 捨てた event でも、送信中の start は待つ
      await core.flush(flushTimeoutMs);
      return eventId;
    } catch {
      // Observability must never make the Worker request fail.
      return null;
    }
  }

  async function captureException(
    error: unknown,
    context: CloudflareCaptureContext = {},
  ): Promise<string | null> {
    try {
      const exception = normalizeException(error, maxCauseDepth, maxStackFrames);
      return await captureAndFlush(
        {
          type: "error",
          platform: "cloudflare",
          level: context.level ?? "error",
          message: exception.values[0]?.value,
          exception,
          ...contextValues(context),
        },
        { originalException: error },
      );
    } catch {
      return null;
    }
  }

  async function captureMessage(
    message: string,
    level: CloudflareCaptureContext["level"] = "info",
    context: Omit<CloudflareCaptureContext, "level"> = {},
  ): Promise<string | null> {
    try {
      return await captureAndFlush({
        type: "error",
        platform: "cloudflare",
        level,
        message,
        ...contextValues(context),
      });
    } catch {
      return null;
    }
  }

  function captureExceptionInBackground(
    executionContext: WaitUntilContext,
    error: unknown,
    context?: CloudflareCaptureContext,
  ): void {
    executionContext.waitUntil(captureException(error, context));
  }

  return {
    captureException,
    captureMessage,
    captureExceptionInBackground,
    flush,
    close: core.close,
  };
}

function contextValues(context: CloudflareCaptureContext) {
  return {
    ...(context.user ? { user: { ...context.user } } : {}),
    ...(context.tags ? { tags: { ...context.tags } } : {}),
    ...(context.contexts ? { contexts: { ...context.contexts } } : {}),
    ...(context.breadcrumbs
      ? { breadcrumbs: context.breadcrumbs.map((breadcrumb) => ({ ...breadcrumb })) }
      : {}),
    ...(context.request ? { request: cloneRequest(context.request) } : {}),
    ...(context.fingerprint?.length ? { fingerprint: [...context.fingerprint] } : {}),
  };
}

function cloneRequest(request: MonicaRequest): MonicaRequest {
  return {
    ...request,
    ...(request.headers ? { headers: { ...request.headers } } : {}),
  };
}

function normalizeException(
  error: unknown,
  maxCauseDepth: number,
  maxStackFrames: number,
): { values: MonicaExceptionValue[] } {
  const values: MonicaExceptionValue[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  const mechanism = { type: "generic" as const, handled: true };
  while (
    current !== undefined &&
    current !== null &&
    values.length < maxCauseDepth &&
    !seen.has(current)
  ) {
    seen.add(current);
    if (current instanceof Error) {
      const frames = parseStack(readErrorString(current, "stack"), maxStackFrames);
      values.push({
        type: readErrorString(current, "name") || "Error",
        value: readErrorString(current, "message") || "Unknown error",
        ...(frames.length ? { stacktrace: { frames } } : {}),
        mechanism,
      });
      current = readErrorCause(current);
    } else {
      values.push({
        type: typeof current,
        value: safeString(current),
        mechanism,
      });
      current = undefined;
    }
  }
  if (values.length === 0) {
    values.push({ type: "Error", value: "Unknown error", mechanism });
  }
  return { values };
}

function readErrorString(error: Error, key: "message" | "name" | "stack"): string | undefined {
  try {
    const value = error[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function readErrorCause(error: Error): unknown {
  try {
    return error.cause;
  } catch {
    return undefined;
  }
}

function parseStack(stack: string | undefined, maxStackFrames: number): MonicaFrame[] {
  if (!stack) return [];
  const frames: MonicaFrame[] = [];
  for (const line of stack.split("\n").slice(1, maxStackFrames + 1)) {
    const match = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!match?.[2] || !match[3] || !match[4]) continue;
    const filename = match[2];
    frames.push({
      filename,
      in_app: !filename.startsWith("node:") && !/[\\/]node_modules[\\/]/.test(filename),
      ...(match[1] ? { function: match[1] } : {}),
      lineno: Number(match[3]),
      colno: Number(match[4]),
    });
  }
  return frames.reverse();
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[Unserializable exception]";
    }
  }
}

function assertPositiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
