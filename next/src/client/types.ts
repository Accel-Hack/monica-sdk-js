import type {
  BeforeSend,
  FetchLike,
  FlushResult,
  MonicaBreadcrumb,
  MonicaLevel,
  MonicaRequest,
  MonicaUser,
} from "@ah-monica/core";

export interface NextClientOptions {
  /** A public DSN containing an `mpk_...` key. Never use an `msk_...` secret in client code. */
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

export interface NextClientCaptureContext {
  level?: MonicaLevel;
  user?: MonicaUser;
  tags?: Record<string, string>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: MonicaBreadcrumb[];
  request?: MonicaRequest;
  fingerprint?: string[];
}

export interface MonicaNextClient {
  captureException(error: unknown, context?: NextClientCaptureContext): Promise<string | null>;
  captureMessage(
    message: string,
    level?: MonicaLevel,
    context?: Omit<NextClientCaptureContext, "level">,
  ): Promise<string | null>;
  setUser(user: MonicaUser | null): void;
  addBreadcrumb(breadcrumb: MonicaBreadcrumb): void;
  /** Install `error` and `unhandledrejection` listeners. Repeated calls are idempotent. */
  installGlobalHandlers(): () => void;
  flush(timeoutMs?: number): Promise<FlushResult>;
  close(timeoutMs?: number): Promise<FlushResult>;
}
