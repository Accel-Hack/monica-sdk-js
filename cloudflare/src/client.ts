import {
  createCoreClient,
  createFetchTransport,
  type CaptureHint,
  type CaptureItemInput,
  type MonicaExceptionValue,
  type MonicaFrame,
  type MonicaRequest,
} from "@ah-monica/core";
import type {
  CloudflareCaptureContext,
  CloudflareClientOptions,
  MonicaCloudflareClient,
  WaitUntilContext,
} from "./types.js";

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_CAUSE_DEPTH = 10;
const DEFAULT_MAX_STACK_FRAMES = 200;

export function createCloudflareClient(
  options: CloudflareClientOptions,
): MonicaCloudflareClient {
  assertPositiveInteger("flushTimeoutMs", options.flushTimeoutMs);
  assertPositiveInteger("maxCauseDepth", options.maxCauseDepth);
  assertPositiveInteger("maxStackFrames", options.maxStackFrames);
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const maxCauseDepth = options.maxCauseDepth ?? DEFAULT_MAX_CAUSE_DEPTH;
  const maxStackFrames = options.maxStackFrames ?? DEFAULT_MAX_STACK_FRAMES;
  const core = createCoreClient({
    transport: createFetchTransport({
      dsn: options.dsn,
      auth: "secret",
      fetch: options.fetch,
      maxRetries: options.maxRetries ?? 0,
      requestTimeoutMs: options.requestTimeoutMs,
    }),
    environment: options.environment,
    release: options.release,
    sampleRate: options.sampleRate,
    beforeSend: options.beforeSend,
    sdk: { name: "@ah-monica/cloudflare", version: "0.1.1" },
  });

  async function captureAndFlush(
    input: CaptureItemInput,
    hint?: CaptureHint,
  ): Promise<string | null> {
    try {
      const eventId = await core.capture(input, hint);
      if (eventId === null) return null;
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
          platform: "javascript",
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
        platform: "javascript",
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
    flush: core.flush,
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
    ...(context.fingerprint ? { fingerprint: [...context.fingerprint] } : {}),
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
