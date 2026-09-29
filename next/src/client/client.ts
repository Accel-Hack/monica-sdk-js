import {
  createCoreClient,
  createFetchTransport,
  type MonicaBreadcrumb,
  type MonicaExceptionValue,
  type MonicaFrame,
  type MonicaRequest,
  type MonicaUser,
  type PresenceState,
  type PresenceStore,
} from "@ah-monica/core";
import { SDK_VERSION } from "./version.js";
import type {
  MonicaNextClient,
  NextClientCaptureContext,
  NextClientOptions,
} from "./types.js";

interface BrowserEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export function createNextClient(options: NextClientOptions): MonicaNextClient {
  const publicKey = options.dsn?.trim() ? parsePublicKey(options.dsn) : undefined;
  assertPositiveInteger("maxBreadcrumbs", options.maxBreadcrumbs);
  const maxBreadcrumbs = positiveInteger(options.maxBreadcrumbs) ? options.maxBreadcrumbs : 50;
  const scope: {
    user?: MonicaUser;
    breadcrumbs: MonicaBreadcrumb[];
  } = { breadcrumbs: [] };
  const inBrowser = typeof window !== "undefined";
  const core = createCoreClient({
    transport: createFetchTransport({
      dsn: options.dsn,
      auth: "public",
      fetch: options.fetch,
      maxRetries: options.maxRetries,
      requestTimeoutMs: options.requestTimeoutMs,
      onDiagnostic: options.onDiagnostic,
    }),
    environment: options.environment,
    release: options.release,
    sampleRate: options.sampleRate,
    maxQueueSize: options.maxQueueSize,
    batchSize: options.batchSize,
    flushIntervalMs: options.flushIntervalMs,
    beforeSend: options.beforeSend,
    sdk: { name: "@ah-monica/next", version: SDK_VERSION },
    // SSR 中に作られた client と dsn の無い client は storage に触らず、稼働確認も送らない
    ...(inBrowser && publicKey
      ? {
          presence: {
            platform: "javascript",
            store: browserPresenceStore(`monica.presence.${publicKey}`),
            applySampleRate: true,
          },
        }
      : {}),
  });
  // ページ読み込み時の 1 回だけ判定する
  void core.checkPresence("start");
  let removeGlobalHandlers: (() => void) | undefined;

  function contextValues(context: NextClientCaptureContext) {
    const user = context.user ?? scope.user;
    const breadcrumbs = [...scope.breadcrumbs, ...(context.breadcrumbs ?? [])].slice(
      -maxBreadcrumbs,
    );
    return {
      ...(user ? { user: { ...user } } : {}),
      ...(context.tags ? { tags: { ...context.tags } } : {}),
      ...(context.contexts ? { contexts: { ...context.contexts } } : {}),
      ...(breadcrumbs.length
        ? { breadcrumbs: breadcrumbs.map((breadcrumb) => ({ ...breadcrumb })) }
        : {}),
      ...(context.request ? { request: cloneRequest(context.request) } : {}),
      ...(context.fingerprint?.length ? { fingerprint: [...context.fingerprint] } : {}),
    };
  }

  function captureExceptionWithMechanism(
    error: unknown,
    context: NextClientCaptureContext,
    mechanism: MonicaExceptionValue["mechanism"],
  ): Promise<string | null> {
    try {
      const exception = normalizeException(error, mechanism);
      return core.capture(
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
      return Promise.resolve(null);
    }
  }

  function captureException(
    error: unknown,
    context: NextClientCaptureContext = {},
  ): Promise<string | null> {
    return captureExceptionWithMechanism(error, context, { type: "generic", handled: true });
  }

  function captureMessage(
    message: string,
    level: NextClientCaptureContext["level"] = "info",
    context: Omit<NextClientCaptureContext, "level"> = {},
  ): Promise<string | null> {
    try {
      return core.capture({
        type: "error",
        platform: "javascript",
        level,
        message,
        ...contextValues(context),
      });
    } catch {
      return Promise.resolve(null);
    }
  }

  function setUser(user: MonicaUser | null): void {
    if (user === null) delete scope.user;
    else scope.user = { ...user };
  }

  function addBreadcrumb(breadcrumb: MonicaBreadcrumb): void {
    scope.breadcrumbs.push({
      timestamp: breadcrumb.timestamp ?? new Date().toISOString(),
      ...breadcrumb,
    });
    if (scope.breadcrumbs.length > maxBreadcrumbs) {
      scope.breadcrumbs.splice(0, scope.breadcrumbs.length - maxBreadcrumbs);
    }
  }

  function installGlobalHandlers(): () => void {
    if (removeGlobalHandlers) return removeGlobalHandlers;
    const target = globalThis as unknown as Partial<BrowserEventTarget>;
    if (!target.addEventListener || !target.removeEventListener) return () => {};
    const onError: EventListener = (event) => {
      // Only an uncaught error arrives as an ErrorEvent. A subresource load
      // failure (a broken <img>, <script> or <link>) is a plain Event with
      // bubbles: false whose target is the element, carrying neither error nor
      // message; capturing one would turn a single broken asset into an ingest
      // request per occurrence, all collapsing into one meaningless issue.
      // Measured in Chrome: such an event only reaches a window listener
      // registered with capture: true, so the bubble-phase registration below
      // does not see it today. This keeps that true if the phase ever changes.
      if (!isUncaughtErrorEvent(event, target)) return;
      const candidate = event as Event & { error?: unknown; message?: string };
      const error = candidate.error ?? candidate.message ?? "Unknown global error";
      void captureAndFlush(error, { type: "onerror", handled: false });
    };
    const onUnhandledRejection: EventListener = (event) => {
      const reason = (event as Event & { reason?: unknown }).reason;
      void captureAndFlush(reason, { type: "onunhandledrejection", handled: false });
    };
    target.addEventListener("error", onError);
    target.addEventListener("unhandledrejection", onUnhandledRejection);
    const remove = () => {
      target.removeEventListener?.("error", onError);
      target.removeEventListener?.("unhandledrejection", onUnhandledRejection);
      if (removeGlobalHandlers === remove) removeGlobalHandlers = undefined;
    };
    removeGlobalHandlers = remove;
    return remove;
  }

  async function captureAndFlush(
    error: unknown,
    mechanism: MonicaExceptionValue["mechanism"],
  ): Promise<void> {
    await captureExceptionWithMechanism(error, {}, mechanism);
    await core.flush();
  }

  async function close(timeoutMs?: number) {
    removeGlobalHandlers?.();
    return core.close(timeoutMs);
  }

  return {
    captureException,
    captureMessage,
    setUser,
    addBreadcrumb,
    installGlobalHandlers,
    flush: core.flush,
    close,
  };
}

/**
 * interval を数え始めた時刻と、header で上書きされた interval / rate を端末に持つ。
 * localStorage が使えなければ sessionStorage、どちらも無ければメモリ。
 * key は project（API key）ごとに分ける。同じ origin で別 project の client を併用しても
 * 互いの start を止めない。
 */
function browserPresenceStore(key: string): PresenceStore {
  const storage = usableStorage("localStorage", key) ?? usableStorage("sessionStorage", key);
  let memory: PresenceState | undefined;
  return {
    load() {
      if (!storage) return memory;
      const raw = storage.getItem(key);
      return raw ? (JSON.parse(raw) as PresenceState) : undefined;
    },
    save(state) {
      if (storage) storage.setItem(key, JSON.stringify(state));
      else memory = state;
    },
  };
}

function usableStorage(
  name: "localStorage" | "sessionStorage",
  key: string,
): Storage | undefined {
  try {
    // private mode や cookie 無効では、読むだけで throw するか setItem が throw する
    const storage = (globalThis as Partial<Record<typeof name, Storage>>)[name];
    if (!storage) return undefined;
    storage.setItem(key, storage.getItem(key) ?? "");
    return storage;
  } catch {
    return undefined;
  }
}

/**
 * Tell an uncaught error from a subresource load failure. Both arrive as "error"
 * on window; only the uncaught error is an ErrorEvent.
 */
function isUncaughtErrorEvent(event: Event, target: unknown): boolean {
  const errorEvent = (globalThis as { ErrorEvent?: unknown }).ErrorEvent;
  if (typeof errorEvent === "function") {
    return event instanceof (errorEvent as new () => Event);
  }
  // Without ErrorEvent, fall back to the target: a subresource failure reports
  // the element, an uncaught error reports window (or nothing at all).
  const eventTarget = (event as { target?: unknown }).target;
  return eventTarget === undefined || eventTarget === null || eventTarget === target;
}

/** dsn の API key を返す。public key（mpk_）でなければ throw する */
function parsePublicKey(dsn: string): string {
  let key: string;
  try {
    key = decodeURIComponent(new URL(dsn).username);
  } catch {
    throw new TypeError("dsn must be a valid URL");
  }
  if (!key.startsWith("mpk_")) {
    throw new TypeError("client dsn must contain a public mpk_ key; never expose an msk_ key");
  }
  return key;
}

function cloneRequest(request: MonicaRequest): MonicaRequest {
  return {
    ...request,
    ...(request.headers ? { headers: { ...request.headers } } : {}),
  };
}

function normalizeException(
  error: unknown,
  mechanism: MonicaExceptionValue["mechanism"],
): { values: MonicaExceptionValue[] } {
  const values: MonicaExceptionValue[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && values.length < 10 && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const name = readErrorString(current, "name") || "Error";
      const value = readErrorString(current, "message") || "Unknown error";
      const frames = parseStack(readErrorString(current, "stack"));
      values.push({
        type: name,
        value,
        ...(frames.length ? { stacktrace: { frames } } : {}),
        mechanism,
      });
      current = readErrorCause(current);
    } else {
      values.push({ type: typeof current, value: safeString(current), mechanism });
      current = undefined;
    }
  }
  if (values.length === 0) values.push({ type: "Error", value: "Unknown error", mechanism });
  return { values };
}

function parseStack(stack: string | undefined): MonicaFrame[] {
  if (!stack) return [];
  const frames: MonicaFrame[] = [];
  for (const line of stack.split("\n").slice(1, 201)) {
    const v8 = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    const gecko = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/.exec(line);
    const match = v8 ?? gecko;
    if (!match?.[2] || !match[3] || !match[4]) continue;
    const filename = match[2];
    frames.push({
      filename,
      in_app: !/[\\/]node_modules[\\/]/.test(filename),
      ...(match[1] ? { function: match[1] } : {}),
      lineno: Number(match[3]),
      colno: Number(match[4]),
    });
  }
  return frames.reverse();
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

function positiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function assertPositiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined && !positiveInteger(value)) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
