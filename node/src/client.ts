import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";
import {
  createCoreClient,
  createFetchTransport,
  type MonicaBreadcrumb,
  type MonicaExceptionValue,
  type MonicaFrame,
  type MonicaUser,
} from "@ah-monica/core";
import { SDK_VERSION } from "./version.js";
import type {
  CaptureContext,
  MonicaNodeClient,
  NodeClientOptions,
  ProcessHookOptions,
  ScopeController,
} from "./types.js";

interface ScopeState {
  user?: MonicaUser;
  tags: Record<string, string>;
  contexts: Record<string, unknown>;
  breadcrumbs: MonicaBreadcrumb[];
}

export function createNodeClient(options: NodeClientOptions): MonicaNodeClient {
  const maxBreadcrumbs = positiveInteger(options.maxBreadcrumbs) ? options.maxBreadcrumbs : 50;
  const storage = new AsyncLocalStorage<ScopeState>();
  const globalScope = emptyScope();
  const core = createCoreClient({
    transport: createFetchTransport({
      dsn: options.dsn,
      auth: "secret",
      fetch: options.fetch,
      maxRetries: options.maxRetries,
      requestTimeoutMs: options.requestTimeoutMs,
    }),
    environment: options.environment,
    release: options.release,
    sampleRate: options.sampleRate,
    maxQueueSize: options.maxQueueSize,
    batchSize: options.batchSize,
    flushIntervalMs: options.flushIntervalMs,
    beforeSend: options.beforeSend,
    sdk: { name: "@ah-monica/node", version: SDK_VERSION },
  });

  function currentScope(): ScopeState {
    return storage.getStore() ?? globalScope;
  }

  function setUser(user: MonicaUser | null): void {
    const scope = currentScope();
    if (user === null) delete scope.user;
    else scope.user = { ...user };
  }

  function addBreadcrumb(breadcrumb: MonicaBreadcrumb): void {
    const scope = currentScope();
    scope.breadcrumbs.push({
      timestamp: breadcrumb.timestamp ?? new Date().toISOString(),
      ...breadcrumb,
    });
    if (scope.breadcrumbs.length > maxBreadcrumbs) {
      scope.breadcrumbs.splice(0, scope.breadcrumbs.length - maxBreadcrumbs);
    }
  }

  function withScope<T>(callback: (scope: ScopeController) => T): T {
    const state = cloneScope(currentScope());
    const controller: ScopeController = {
      setUser(user) {
        if (user === null) delete state.user;
        else state.user = { ...user };
      },
      setTag(key, value) {
        state.tags[key] = value;
      },
      setContext(key, value) {
        state.contexts[key] = value;
      },
      addBreadcrumb(breadcrumb) {
        state.breadcrumbs.push({
          timestamp: breadcrumb.timestamp ?? new Date().toISOString(),
          ...breadcrumb,
        });
        if (state.breadcrumbs.length > maxBreadcrumbs) state.breadcrumbs.shift();
      },
    };
    return storage.run(state, () => callback(controller));
  }

  function contextValues(context: CaptureContext) {
    const scope = currentScope();
    const user = context.user ?? scope.user;
    const tags = { ...scope.tags, ...context.tags };
    const contexts = { ...scope.contexts, ...context.contexts };
    const breadcrumbs = [...scope.breadcrumbs, ...(context.breadcrumbs ?? [])].slice(
      -maxBreadcrumbs,
    );
    return {
      ...(user ? { user: { ...user } } : {}),
      ...(Object.keys(tags).length ? { tags } : {}),
      ...(Object.keys(contexts).length ? { contexts } : {}),
      ...(breadcrumbs.length ? { breadcrumbs } : {}),
      ...(context.request ? { request: context.request } : {}),
      ...(context.fingerprint ? { fingerprint: context.fingerprint } : {}),
    };
  }

  function captureException(
    error: unknown,
    context: CaptureContext = {},
  ): Promise<string | null> {
    return captureExceptionWithMechanism(error, context, {
      type: "generic",
      handled: true,
    });
  }

  function captureExceptionWithMechanism(
    error: unknown,
    context: CaptureContext,
    mechanism: MonicaExceptionValue["mechanism"],
  ): Promise<string | null> {
    const exception = normalizeException(error, mechanism);
    return core.capture(
      {
        type: "error",
        platform: "node",
        level: context.level ?? "error",
        message: exception.values[0]?.value,
        exception,
        ...contextValues(context),
      },
      { originalException: error },
    );
  }

  function captureMessage(
    message: string,
    level: CaptureContext["level"] = "info",
    context: Omit<CaptureContext, "level"> = {},
  ): Promise<string | null> {
    return core.capture({
      type: "error",
      platform: "node",
      level,
      message,
      ...contextValues(context),
    });
  }

  function installProcessHooks(hooks: ProcessHookOptions = {}): () => void {
    const captureUncaught = hooks.uncaughtException ?? true;
    // Observing unhandledRejection installs a listener and therefore changes
    // Node's default termination behavior. Keep it opt-in; Node's default
    // throw mode is still observed through uncaughtExceptionMonitor.
    const captureRejection = hooks.unhandledRejection ?? false;
    const onUncaughtException = (error: Error) => {
      void captureExceptionWithMechanism(error, { level: "fatal" }, {
        type: "onerror",
        handled: false,
      });
    };
    const onUnhandledRejection = (reason: unknown) => {
      void captureExceptionWithMechanism(reason, { level: "error" }, {
        type: "onunhandledrejection",
        handled: false,
      });
    };
    const events = process as unknown as {
      on(event: "uncaughtExceptionMonitor", listener: (error: Error) => void): void;
      on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
      off(event: "uncaughtExceptionMonitor", listener: (error: Error) => void): void;
      off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
    };
    if (captureUncaught) events.on("uncaughtExceptionMonitor", onUncaughtException);
    if (captureRejection) events.on("unhandledRejection", onUnhandledRejection);
    return () => {
      if (captureUncaught) events.off("uncaughtExceptionMonitor", onUncaughtException);
      if (captureRejection) events.off("unhandledRejection", onUnhandledRejection);
    };
  }

  return {
    captureException,
    captureMessage,
    setUser,
    addBreadcrumb,
    withScope,
    flush: core.flush,
    close: core.close,
    installProcessHooks,
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
      const frames = parseStack(current.stack);
      values.push({
        type: current.name || "Error",
        value: current.message,
        ...(frames.length ? { stacktrace: { frames } } : {}),
        mechanism,
      });
      current = current.cause;
    } else {
      values.push({
        type: typeof current,
        value: safeString(current),
        mechanism,
      });
      current = undefined;
    }
  }
  return { values };
}

function parseStack(stack: string | undefined): MonicaFrame[] {
  if (!stack) return [];
  const frames: MonicaFrame[] = [];
  for (const line of stack.split("\n").slice(1, 201)) {
    const match = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!match) continue;
    const filename = match[2];
    const frame: MonicaFrame = {
      filename,
      in_app: !filename.startsWith("node:") && !/[\\/]node_modules[\\/]/.test(filename),
      ...(match[1] ? { function: match[1] } : {}),
      lineno: Number(match[3]),
      colno: Number(match[4]),
    };
    frames.push(frame);
  }
  return frames.reverse();
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function emptyScope(): ScopeState {
  return { tags: {}, contexts: {}, breadcrumbs: [] };
}

function cloneScope(scope: ScopeState): ScopeState {
  return {
    ...(scope.user ? { user: { ...scope.user } } : {}),
    tags: { ...scope.tags },
    contexts: { ...scope.contexts },
    breadcrumbs: scope.breadcrumbs.map((breadcrumb) => ({ ...breadcrumb })),
  };
}

function positiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}
