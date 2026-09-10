import { SDK_VERSION } from "./version.js";
import type {
  CaptureHint,
  CaptureItemInput,
  CoreClientOptions,
  FlushResult,
  MonicaCoreClient,
  MonicaItem,
  TransportResult,
} from "./types.js";

const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;
const MAX_ENVIRONMENT_LENGTH = 128;
// The server limit is 1 MiB after gzip. Keeping the JSON representation below
// 1,000,000 bytes leaves room for gzip framing and is a safe preflight bound.
const MAX_SAFE_ENVELOPE_JSON_BYTES = 1_000_000;
const encoder = new TextEncoder();

export function createCoreClient(options: CoreClientOptions): MonicaCoreClient {
  assertOptions(options);
  const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  const batchSize = Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, maxQueueSize, 100);
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const sampleRate = options.sampleRate ?? 1;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const generateEventId = options.generateEventId ?? (() => crypto.randomUUID());
  const sdk = options.sdk ?? { name: "@ah-monica/core", version: SDK_VERSION };

  const queue: MonicaItem[] = [];
  const pendingCaptures = new Set<Promise<unknown>>();
  let discarded = 0;
  let closed = false;
  // 直前に受理されなかった送信の status / issues / error。flush が返して忘れる。
  // 422 の issues は「送っているのに届かない」原因そのものなので、警告を読めない
  // 経路（テスト・バッチ・自前の監視）からも取れるようにしておく。
  let lastRejection: RejectionDetails | undefined;
  // transport.json: 401 は drop_and_stop。一度立つと戻らない
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<boolean> | undefined;

  function scheduleTimer(): void {
    if (timer !== undefined || queue.length === 0 || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void sendBatch();
    }, flushIntervalMs);
    const candidate = timer as unknown as { unref?: () => void };
    candidate.unref?.();
  }

  function clearTimer(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  /**
   * 401（`drop_and_stop`）を受けたあとの後始末。鍵が失効・ローテートされた長寿命
   * プロセスが、絶対に受理されない endpoint へ flushIntervalMs ごとに永久に POST し
   * 続けるのを止める。queue に残った分を持ち続けても二度と送れず、残すと flush が
   * deadline まで空回りするので、捨てた分として勘定して報告する。
   */
  function stopSending(): void {
    if (stopped) return;
    stopped = true;
    closed = true;
    clearTimer();
    discarded += queue.length;
    queue.length = 0;
  }

  /**
   * items を 1 envelope として送る。`413` なら item 単位で半分に割って送り直し
   * （transport.json の `split_and_retry`）、1 件でも `413` なら捨てる。
   *
   * ここは reject しない。`void sendBatch()` の 2 か所が promise を捨てるので、
   * rejection は unhandled rejection になり Node は既定でプロセスを落とす。
   */
  async function deliver(
    items: MonicaItem[],
    reportedDiscarded: number,
    sentAt: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let result: TransportResult;
    try {
      // 同期的に throw する transport も rejection 経路に寄せる
      result = await (async () =>
        options.transport.send(
          { sdk, sent_at: sentAt, discarded: reportedDiscarded, items },
          signal,
        ))();
    } catch {
      discarded += items.length + reportedDiscarded;
      return false;
    }
    if (result.stop) stopSending();
    if (result.accepted) return true;
    if (result.status === 413 && items.length > 1 && !stopped) {
      // 分割の境界は item（ingest.md）。捨てた分の勘定は前半の envelope にだけ載せ、
      // sent_at は分割前のものを使い回す（分割は 1 回の送信の続きなので）
      const half = Math.floor(items.length / 2);
      const first = await deliver(items.slice(0, half), reportedDiscarded, sentAt, signal);
      const second = await deliver(items.slice(half), 0, sentAt, signal);
      return first && second;
    }
    discarded += items.length + reportedDiscarded;
    lastRejection = rejectionDetails(result);
    return false;
  }

  async function sendBatch(signal?: AbortSignal): Promise<boolean> {
    if (sending) return sending;
    if (stopped) return false;
    if (queue.length === 0) return true;
    clearTimer();
    let oversizedDrops = 0;
    let items: MonicaItem[] | undefined;
    let sentAt = "";
    while (queue.length > 0 && !items) {
      try {
        sentAt = now().toISOString();
      } catch {
        // A caller-supplied `now` that throws (or returns an invalid Date) leaves
        // no way to build sent_at, so this batch can never go out. Account for it
        // as discarded and return: observability must not take the host
        // application down, and both `void sendBatch()` sites drop the promise,
        // so a rejection here would surface as an unhandled rejection.
        discarded += queue.splice(0, Math.min(batchSize, queue.length)).length;
        scheduleTimer();
        return false;
      }
      let count = Math.min(batchSize, queue.length);
      while (count > 0) {
        const candidate = {
          sdk,
          sent_at: sentAt,
          discarded,
          items: queue.slice(0, count),
        };
        let byteLength = Number.POSITIVE_INFINITY;
        try {
          byteLength = encoder.encode(JSON.stringify(candidate)).byteLength;
        } catch {
          // Treat non-serializable application context like any other item that
          // cannot fit the wire contract. The host application must not fail.
        }
        if (byteLength <= MAX_SAFE_ENVELOPE_JSON_BYTES) {
          items = queue.splice(0, count);
          break;
        }
        count -= 1;
      }
      if (!items) {
        queue.shift();
        discarded += 1;
        oversizedDrops += 1;
      }
    }
    if (!items) return oversizedDrops === 0;
    const reportedDiscarded = discarded;
    discarded = 0;
    const operation = deliver(items, reportedDiscarded, sentAt, signal).then(
      (accepted) => accepted && oversizedDrops === 0,
    );
    sending = operation;
    try {
      return await operation;
    } finally {
      if (sending === operation) sending = undefined;
      scheduleTimer();
    }
  }

  function capture(input: CaptureItemInput, hint: CaptureHint = {}): Promise<string | null> {
    if (closed) return Promise.resolve(null);
    const operation = (async () => {
      if (random() >= sampleRate) return null;
      const eventId = typeof input.event_id === "string" ? input.event_id : generateEventId();
      const timestamp = typeof input.timestamp === "string" ? input.timestamp : now().toISOString();
      let item: MonicaItem = {
        ...input,
        event_id: eventId,
        timestamp,
        environment: input.environment ?? options.environment,
        ...(options.release !== undefined && input.release === undefined
          ? { release: options.release }
          : {}),
      } as MonicaItem;

      // PII is deliberately not inferred here. Applications own the payload and
      // can remove or reject values in beforeSend.
      if (options.beforeSend) {
        const processed = await options.beforeSend(item, hint);
        if (processed === null) return null;
        item = processed;
      }

      // The adapters drop these while building the item, but beforeSend runs
      // afterwards and core.capture is a published entry point, so neither path
      // is covered by that guard.
      item = withoutEmptyContractArrays(item);

      if (queue.length >= maxQueueSize) {
        queue.shift();
        discarded += 1;
      }
      queue.push(item);
      if (item.level === "fatal" || queue.length >= batchSize) void sendBatch();
      else scheduleTimer();
      return eventId;
    })().catch(() => null);
    pendingCaptures.add(operation);
    void operation.finally(() => pendingCaptures.delete(operation));
    return operation;
  }

  /**
   * 直前の拒否の内容を載せて返し、載せた分は忘れる。欄は値があるときだけ作るので、
   * 拒否が無ければ従来どおり `{ accepted, discarded, remaining }` の 3 欄だけになる。
   */
  function flushResult(accepted: boolean): FlushResult {
    const details = lastRejection;
    lastRejection = undefined;
    return {
      // 401 で閉じたあとは送る先が無いので、待つものが無くても受理は主張しない
      accepted: accepted && !stopped,
      discarded,
      remaining: queue.length,
      ...details,
      // status と違い、閉じたことは flush をまたいでも分かるように残す
      ...(stopped ? { stopped: true } : {}),
    };
  }

  async function flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<FlushResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let accepted = true;
    while (pendingCaptures.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return flushResult(false);
      const completed = await withTimeout(Promise.allSettled([...pendingCaptures]), remaining);
      if (!completed) return flushResult(false);
    }
    while (queue.length > 0 || sending) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return flushResult(false);
      const operation = sending ?? sendBatch();
      const result = await withTimeout(operation, remaining);
      if (result === undefined) return flushResult(false);
      accepted = accepted && result;
    }
    clearTimer();
    return flushResult(accepted);
  }

  async function close(timeoutMs?: number): Promise<FlushResult> {
    closed = true;
    clearTimer();
    return flush(timeoutMs);
  }

  return { capture, flush, close };
}

type RejectionDetails = Pick<FlushResult, "status" | "issues" | "error">;

/**
 * transport が返した拒否の内容のうち、利用者に渡せるものだけを写す。
 * network 障害のように status も body も無い場合は空になる。
 */
function rejectionDetails(result: TransportResult): RejectionDetails {
  return {
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.issues && result.issues.length > 0 ? { issues: result.issues } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * Drop the two empty arrays the wire contract forbids: `fingerprint` and
 * `exception.values` are the only `minItems: 1` constraints on an error item,
 * and a `422` discards the whole envelope, so one such item takes every
 * unrelated event batched alongside it down with it. Both fields are optional,
 * so dropping them lets the event through.
 *
 * This is not payload validation — choosing what to send stays with the
 * application (see beforeSend). It only removes values that could never reach
 * MONICA and would destroy other events on the way out.
 */
function withoutEmptyContractArrays(item: MonicaItem): MonicaItem {
  const emptyFingerprint = Array.isArray(item.fingerprint) && item.fingerprint.length === 0;
  const emptyValues =
    item.exception !== undefined &&
    Array.isArray(item.exception.values) &&
    item.exception.values.length === 0;
  if (!emptyFingerprint && !emptyValues) return item;
  // beforeSend may hand back an object the application still holds onto.
  const copy = { ...item };
  if (emptyFingerprint) delete copy.fingerprint;
  if (emptyValues) delete copy.exception;
  return copy;
}

function assertOptions(options: CoreClientOptions): void {
  if (typeof options.environment !== "string" || !options.environment.trim()) {
    throw new TypeError("environment must not be empty");
  }
  if (options.environment.length > MAX_ENVIRONMENT_LENGTH) {
    throw new RangeError(`environment must not exceed ${MAX_ENVIRONMENT_LENGTH} characters`);
  }
  if (
    options.sampleRate !== undefined &&
    (!Number.isFinite(options.sampleRate) || options.sampleRate < 0 || options.sampleRate > 1)
  ) {
    throw new RangeError("sampleRate must be between 0 and 1");
  }
  for (const [name, value] of [
    ["maxQueueSize", options.maxQueueSize],
    ["batchSize", options.batchSize],
    ["flushIntervalMs", options.flushIntervalMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        const candidate = timer as unknown as { unref?: () => void };
        candidate.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
