import type {
  BeforeSend,
  FetchLike,
  FlushResult,
  MonicaBreadcrumb,
  MonicaLevel,
  MonicaRequest,
  MonicaUser,
} from "@ah-monica/core";

export interface NodeClientOptions {
  dsn: string;
  environment: string;
  release?: string;
  sampleRate?: number;
  maxBreadcrumbs?: number;
  maxQueueSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  /**
   * The application owns PII removal. MONICA does not infer which values are PII.
   * Return null to discard an event or return a sanitized event to send it.
   */
  beforeSend?: BeforeSend;
  fetch?: FetchLike;
}

export interface CaptureContext {
  level?: MonicaLevel;
  user?: MonicaUser;
  tags?: Record<string, string>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: MonicaBreadcrumb[];
  request?: MonicaRequest;
  fingerprint?: string[];
}

export interface ScopeController {
  setUser(user: MonicaUser | null): void;
  setTag(key: string, value: string): void;
  setContext(key: string, value: unknown): void;
  addBreadcrumb(breadcrumb: MonicaBreadcrumb): void;
}

export interface ProcessHookOptions {
  uncaughtException?: boolean;
  unhandledRejection?: boolean;
}

export interface MonicaNodeClient {
  captureException(error: unknown, context?: CaptureContext): Promise<string | null>;
  captureMessage(
    message: string,
    level?: MonicaLevel,
    context?: Omit<CaptureContext, "level">,
  ): Promise<string | null>;
  setUser(user: MonicaUser | null): void;
  addBreadcrumb(breadcrumb: MonicaBreadcrumb): void;
  withScope<T>(callback: (scope: ScopeController) => T): T;
  flush(timeoutMs?: number): Promise<FlushResult>;
  close(timeoutMs?: number): Promise<FlushResult>;
  installProcessHooks(options?: ProcessHookOptions): () => void;
}
