/**
 * 公開契約バンドルの vendoring コピー（spec/v1/）を配信元と同期する。
 *
 *   bun run spec:sync            配信元を取得し、spec/v1/ を上書きする
 *   bun run spec:check           取得して比べるだけ。差分があれば exit 1
 *   ... --report <path>          差分の要約を markdown で書き出す（同期 PR の本文用）
 *
 * 配信元は https://spec.monica.accelhack.net/v1/。パスの v1 は Ingest API の版で
 * バンドル自身の版ではないので、中身は変わってよい。どの契約で作ったかを記録して
 * いるのはこの repository の git 履歴。
 *
 * 取り込みは index.json から始める。全ファイルの path と sha256、バンドル全体の
 * revision が並んでいるので、列挙・整合性検査・上流でファイルが増えたことの検知は
 * すべてそこで済む。index.json がまだ配信されていない間は、手元のコピーにある
 * ファイルだけを取り直す（上流で増えたファイルはこの経路では見つからない）。
 *
 * この script は CI の pull_request では回さない。fork からの PR は外部通信の前提が
 * 揃わないため。schedule / workflow_dispatch の spec-sync.yml だけが呼ぶ。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export const ORIGIN = "https://spec.monica.accelhack.net";
export const VERSION = "v1";
export const BASE = `${ORIGIN}/${VERSION}/`;
const SPEC_DIR = resolve(import.meta.dir, "..", "spec", VERSION);

interface IndexFile {
  path: string;
  sha256: string;
}

interface Index {
  version: string;
  base: string;
  revision: string;
  files: IndexFile[];
}

export interface SyncResult {
  revision: string | undefined;
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
  /** index.json が無く、手元のファイル一覧で代替したか */
  fallback: boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * index.json の revision の定義（バンドルの README より）: files を path の byte 順に
 * 並べ、各要素を「ダイジェスト、空白 2 つ、path」の 1 行にして改行で繋いだ文字列
 * （末尾に改行なし）の sha256。
 */
export function computeRevision(files: IndexFile[]): string {
  const lines = files.map((file) => `${file.sha256}  ${file.path}`).join("\n");
  return sha256(new TextEncoder().encode(lines));
}

function byteOrder(a: string, b: string): number {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return Buffer.compare(left, right);
}

async function fetchBytes(path: string): Promise<Uint8Array | undefined> {
  const response = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: { "User-Agent": "monica-sdk-js spec-sync" },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function localFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(SPEC_DIR, path).split(sep).join("/"));
    }
  };
  if (exists(SPEC_DIR)) walk(SPEC_DIR);
  return found.sort(byteOrder);
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

async function readLocal(path: string): Promise<Uint8Array | undefined> {
  const file = Bun.file(resolve(SPEC_DIR, path));
  if (!(await file.exists())) return undefined;
  return new Uint8Array(await file.arrayBuffer());
}

/** 配信元の一覧を決める。index.json があればそれ、無ければ手元のコピーの一覧 */
async function upstreamListing(): Promise<{ index: Index | undefined; paths: string[] }> {
  const raw = await fetchBytes("index.json");
  if (!raw) {
    console.warn(
      "index.json は配信されていない。手元のコピーにあるファイルだけを取り直す（上流で増えたファイルは見つからない）",
    );
    return { index: undefined, paths: localFiles().filter((path) => path !== "index.json") };
  }
  const index = JSON.parse(new TextDecoder().decode(raw)) as Index;
  if (index.version !== VERSION) {
    throw new Error(`index.json の version が ${index.version}。${VERSION} を期待している`);
  }
  if (index.base !== BASE) {
    // 複製を読んでいる可能性がある。信じるのは自分の設定した取得先とダイジェストの方
    console.warn(`index.json の base は ${index.base}。取得先は ${BASE}`);
  }
  const sorted = [...index.files].sort((a, b) => byteOrder(a.path, b.path));
  if (sorted.some((file, i) => file.path !== index.files[i]?.path)) {
    throw new Error("index.json の files が path の byte 順に並んでいない");
  }
  if (computeRevision(index.files) !== index.revision) {
    throw new Error("index.json の revision が files から再計算した値と一致しない");
  }
  return { index, paths: index.files.map((file) => file.path) };
}

export async function sync(options: { write: boolean }): Promise<SyncResult> {
  const { index, paths } = await upstreamListing();
  const digests = new Map(index?.files.map((file) => [file.path, file.sha256]) ?? []);
  const fetched = new Map<string, Uint8Array>();

  for (const path of paths) {
    const bytes = await fetchBytes(path);
    if (!bytes) throw new Error(`${path}: index.json に載っているのに 404`);
    const expected = digests.get(path);
    if (expected && sha256(bytes) !== expected) {
      throw new Error(`${path}: sha256 が index.json と一致しない（取得中に更新された可能性）`);
    }
    fetched.set(path, bytes);
  }
  if (index) {
    const raw = await fetchBytes("index.json");
    if (!raw) throw new Error("index.json が取得中に消えた");
    fetched.set("index.json", raw);
  }

  const result: SyncResult = {
    revision: index?.revision,
    added: [],
    changed: [],
    removed: [],
    unchanged: 0,
    fallback: index === undefined,
  };
  for (const [path, bytes] of fetched) {
    const local = await readLocal(path);
    if (local === undefined) result.added.push(path);
    else if (Buffer.compare(local, bytes) !== 0) result.changed.push(path);
    else result.unchanged += 1;
  }
  // index.json があるときだけ、上流に無いファイルを消す。fallback では一覧が手元由来なので判断できない
  if (index) {
    for (const path of localFiles()) {
      if (!fetched.has(path)) result.removed.push(path);
    }
  }

  if (options.write) {
    for (const [path, bytes] of fetched) {
      const target = resolve(SPEC_DIR, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    for (const path of result.removed) rmSync(resolve(SPEC_DIR, path));
  }
  return result;
}

export function report(result: SyncResult): string {
  const lines: string[] = [];
  lines.push(`配信元: ${BASE}`);
  if (result.revision) lines.push(`revision: \`${result.revision}\``);
  if (result.fallback) {
    lines.push(
      "index.json が配信されていないため、手元のコピーにあるファイルだけを取り直した。上流で増えたファイルはこの経路では見つからない。",
    );
  }
  const list = (title: string, paths: string[]) => {
    if (paths.length === 0) return;
    lines.push("", `**${title}**`, "", ...paths.map((path) => `- \`${path}\``));
  };
  list("追加", result.added);
  list("変更", result.changed);
  list("削除", result.removed);
  lines.push("", `変わらないファイル: ${result.unchanged}`);
  return `${lines.join("\n")}\n`;
}

function hasDiff(result: SyncResult): boolean {
  return result.added.length + result.changed.length + result.removed.length > 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const reportIndex = args.indexOf("--report");
  const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : undefined;
  if (reportIndex >= 0 && !reportPath) {
    console.error("--report にはパスが要る");
    process.exit(2);
  }

  const result = await sync({ write: !check });
  const text = report(result);
  process.stdout.write(text);
  if (reportPath) writeFileSync(reportPath, text);

  if (hasDiff(result)) {
    console.log(check ? "spec/v1 は配信元と食い違っている" : "spec/v1 を更新した");
    process.exit(check ? 1 : 0);
  }
  console.log("spec/v1 は配信元と一致している");
}
