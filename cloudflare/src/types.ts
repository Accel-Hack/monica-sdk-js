import type {
  BeforeSend,
  FetchLike,
  FlushResult,
  MonicaBreadcrumb,
  MonicaLevel,
  MonicaRequest,
  MonicaUser,
  TransportDiagnosticHandler,
} from "@ah-monica/core";

export interface CloudflareClientOptions {
  dsn: string;
  environment: string;
  release?: string;
  sampleRate?: number;
  requestTimeoutMs?: number;
  flushTimeoutMs?: number;
  maxRetries?: number;
  maxCauseDepth?: number;
  maxStackFrames?: number;
  /**
   * ingest が envelope を拒否したときの診断の受け取り先。既定は `console.warn` に
   * 1 行出す（422 の `issues` の path を含む）。`null` を渡すと何も出さない。
   */
  onDiagnostic?: TransportDiagnosticHandler | null;
  /**
   * The application owns PII removal. MONICA does not infer which values are PII.
   * Return null to discard an event or return a sanitized event to send it.
   */
  beforeSend?: BeforeSend;
  fetch?: FetchLike;
}

export interface CloudflareCaptureContext {
  level?: MonicaLevel;
  user?: MonicaUser;
  tags?: Record<string, string>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: MonicaBreadcrumb[];
  request?: MonicaRequest;
  fingerprint?: string[];
}

/** The part of Cloudflare's ExecutionContext used by this adapter. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface MonicaCloudflareClient {
  /** Captures and flushes one exception. Pass this Promise to ctx.waitUntil(). */
  captureException(
    error: unknown,
    context?: CloudflareCaptureContext,
  ): Promise<string | null>;
  captureMessage(
    message: string,
    level?: MonicaLevel,
    context?: Omit<CloudflareCaptureContext, "level">,
  ): Promise<string | null>;
  /** Registers captureException with ctx.waitUntil() without losing its binding. */
  captureExceptionInBackground(
    executionContext: WaitUntilContext,
    error: unknown,
    context?: CloudflareCaptureContext,
  ): void;
  flush(timeoutMs?: number): Promise<FlushResult>;
  close(timeoutMs?: number): Promise<FlushResult>;
}
