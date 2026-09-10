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

/** error.json の `error.issues[]`。ingest が返す field-level の診断 1 件。 */
export interface TransportIssue {
  path: string;
  message: string;
}

/**
 * error.json の `error` のうち `issues` を除いた部分。`code` は人が読むためのもので、
 * SDK の分岐は HTTP status で行う（ingest.md）。
 */
export interface TransportError {
  code: string;
  message: string;
}

export interface TransportResult {
  accepted: boolean;
  status?: number;
  /**
   * 422 のレスポンス body から読めた `error.issues`。読めなかった場合（body が空・
   * 非 JSON・上限超過・形が違う）は欄ごと無い。破棄の判断は status で行うので、
   * この欄の有無で挙動は変わらない。
   */
  issues?: TransportIssue[];
  /** 4xx のレスポンス body から読めた `error.code` / `error.message`。 */
  error?: TransportError;
  /**
   * transport.json の `drop_and_stop`（401）。これを受けた client は以後送信しない。
   * 鍵が失効した長寿命プロセスが永久に POST し続けるのを止めるための欄。
   */
  stop?: boolean;
}

/**
 * ingest が envelope を拒否したときに 1 envelope につき 1 回渡される診断。
 * retry のたびには渡さない。
 */
export interface TransportDiagnostic {
  status: number;
  issues: TransportIssue[];
  error?: TransportError;
  /**
   * 既定の警告出力に使う 1 行。API key や envelope 本体は含まない
   * （`path` と `message` は ingest が返した検証結果そのもの）。
   */
  message: string;
}

export type TransportDiagnosticHandler = (diagnostic: TransportDiagnostic) => void;

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
  /**
   * 直前に受理されなかった送信の HTTP status。前回 flush 以降に受理されなかった
   * 送信が無い場合、または network 障害で status が無い場合は欄ごと無い。
   */
  status?: number;
  /** その送信で読めた `error.issues`（実質 422 のみ）。 */
  issues?: TransportIssue[];
  /** その送信で読めた `error.code` / `error.message`。 */
  error?: TransportError;
  /**
   * 401（`drop_and_stop`）を受けて client が閉じたあとは `true`。閉じたあとの
   * `capture` は `null` を返し、queue に残っていた分は `discarded` に勘定される。
   * 一度立つと戻らないので、`status` と違って flush をまたいで残る。
   */
  stopped?: boolean;
}

export interface MonicaCoreClient {
  capture(input: CaptureItemInput, hint?: CaptureHint): Promise<string | null>;
  flush(timeoutMs?: number): Promise<FlushResult>;
  close(timeoutMs?: number): Promise<FlushResult>;
}
