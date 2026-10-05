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
  platform: "javascript" | "node" | "cloudflare" | "java" | "php";
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

/**
 * 稼働確認（payload.md「client_report と稼働確認」）。capture や beforeSend は通らず、
 * client が単独の envelope で送る。
 */
export interface MonicaClientReportItem {
  type: "client_report";
  timestamp: string;
  platform: MonicaErrorItem["platform"];
  environment: string;
  trigger: "start" | "interval" | "stop";
  release?: string;
}

export interface MonicaEnvelope {
  sdk: { name: string; version: string };
  sent_at: string;
  discarded: number;
  items: Array<MonicaItem | MonicaClientReportItem>;
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
  /**
   * 受理された応答の `X-Monica-Presence-Interval-Ms` / `X-Monica-Presence-Sample-Rate`
   * を読んだままの文字列。header が無ければ欄ごと無い。値の検証と保存は client が行う。
   */
  presence?: { intervalMs?: string; sampleRate?: string };
}

/**
 * 稼働確認の判定に使う状態。`intervalStartedAt` は interval を数え始めた時刻（epoch ms）。
 * interval が過ぎたと判定したとき（抽選・送信の前）と `202` を受けたときに書く。
 * `intervalMs` / `sampleRate` は `202` の応答 header で MONICA が上書きした値。
 */
export interface PresenceState {
  intervalStartedAt?: number;
  intervalMs?: number;
  sampleRate?: number;
}

/** PresenceState の置き場所。既定は client ごとのメモリ。配布物は端末のストレージに差し替える */
export interface PresenceStore {
  load(): PresenceState | undefined;
  save(state: PresenceState): void;
}

export interface PresenceOptions {
  /** client_report の `platform`。error item に入れている値と同じにする */
  platform: MonicaErrorItem["platform"];
  store?: PresenceStore;
  /** 配布物（browser など）だけ true。`sampleRate` の確率で間引く */
  applySampleRate?: boolean;
}

/**
 * ingest が envelope を拒否したときに渡される診断。retry のたびには渡さない。
 * 422 は 1 envelope につき 1 回、401 と 413 は transport につき 1 回。
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
  /**
   * 稼働確認を送る adapter が渡す。無ければ `checkPresence` は何も送らない。
   * error の間引き（`sampleRate`）とは別物。
   */
  presence?: PresenceOptions;
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
   *
   * 分割して送り直した `413`（`split_and_retry`）も、割った先がすべて受理されて
   * `accepted: true` になる場合を含めてここに残る。経路上の何かが契約より低い
   * body 上限を持っている信号なので、握り潰さない。
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
  /**
   * 直近の interval に `202` を受けていなければ、client_report を単独の envelope で送る。
   * queue に error が溜まっている・送信中のときは送らない（そちらの `202` で足りる）。
   * 送信は error と同じ経路（status ごとの挙動・discarded の勘定）を通る。
   * 戻り値は次に判定すべきまでの ms。
   */
  checkPresence(trigger: "start" | "interval"): Promise<number>;
}
