export type MonicaLevel = "fatal" | "error" | "warning" | "info" | "debug";

export interface MonicaFrame {
  filename: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
  abs_path?: string;
}

export interface MonicaExceptionValue {
  type: string;
  value: string;
  stacktrace?: { frames: MonicaFrame[] };
  mechanism?: {
    type: "onerror" | "onunhandledrejection" | "generic";
    handled: boolean;
  };
}

export interface MonicaBreadcrumb {
  timestamp?: string;
  type?: string;
  category?: string;
  message?: string;
  level?: MonicaLevel;
  data?: Record<string, unknown>;
}

export interface MonicaUser {
  id?: string;
  email?: string;
  ip?: string;
  [key: string]: unknown;
}

export interface MonicaRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface MonicaErrorItem {
  type: "error";
  event_id: string;
  timestamp: string;
  level: MonicaLevel;
  platform: "javascript" | "node" | "java" | "php";
  environment: string;
  release?: string;
  server_name?: string;
  message?: string;
  exception?: { values: MonicaExceptionValue[] };
  breadcrumbs?: MonicaBreadcrumb[];
  request?: MonicaRequest;
  user?: MonicaUser;
  tags?: Record<string, string>;
  contexts?: Record<string, unknown>;
  fingerprint?: string[];
}

// The protocol accepts unknown future item types, but this SDK only emits the
// error item implemented today. Keeping the outbound type narrow prevents an
// invalid `{ type: "error" }` from satisfying a catch-all string branch.
export type MonicaItem = MonicaErrorItem;

export interface MonicaEnvelope {
  sdk: { name: string; version: string };
  sent_at: string;
  discarded: number;
  items: MonicaItem[];
}

export interface CaptureHint {
  originalException?: unknown;
  [key: string]: unknown;
}

export type BeforeSend = (
  item: MonicaItem,
  hint: CaptureHint,
) => MonicaItem | null | Promise<MonicaItem | null>;

export interface TransportResult {
  accepted: boolean;
  status?: number;
}

export interface MonicaTransport {
  send(envelope: MonicaEnvelope, signal?: AbortSignal): Promise<TransportResult>;
}

export interface CoreClientOptions {
  transport: MonicaTransport;
  environment: string;
  release?: string;
  sampleRate?: number;
  maxQueueSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  beforeSend?: BeforeSend;
  sdk?: { name: string; version: string };
  now?: () => Date;
  random?: () => number;
  generateEventId?: () => string;
}

export type CaptureItemInput = Omit<
  MonicaErrorItem,
  "event_id" | "timestamp" | "environment" | "release"
> & {
  event_id?: string;
  timestamp?: string;
  environment?: string;
  release?: string;
} & Record<string, unknown>;

export interface FlushResult {
  accepted: boolean;
  discarded: number;
  remaining: number;
}

export interface MonicaCoreClient {
  capture(input: CaptureItemInput, hint?: CaptureHint): Promise<string | null>;
  flush(timeoutMs?: number): Promise<FlushResult>;
  close(timeoutMs?: number): Promise<FlushResult>;
}
