/**
 * この repository は public なので、追跡している全ファイルが公開面になる。
 * 非公開の設計サイトへのリンクや、設計サイトの決定ログ番号への参照が混ざると、
 * 利用者には辿れない参照を配ることになる。一度公開すると git の履歴から消えないので、
 * 混ざる前にここで落とす。
 *
 * 顧客名などの denylist は持たない。denylist をここに書くこと自体が公開になる。
 * それは移設元の private 側で検査している。
 */
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const root = resolve(import.meta.dir, "..");

const BINARY =
  /\.(png|jpe?g|gif|webp|ico|svgz|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|wasm|mp4|mov|webm)$/i;

async function trackedFiles(): Promise<string[]> {
  const git = Bun.spawn(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(git.stdout).text(), git.exited]);
  if (code !== 0) throw new Error(`git ls-files が失敗した: ${code}`);
  return out
    .split("\0")
    .filter((path) => path !== "" && !BINARY.test(path))
    .sort();
}

async function contentsOf(path: string): Promise<string> {
  return Bun.file(resolve(root, path)).text();
}

/** 非公開のホスト。Cloudflare Access の内側にあり、公開 SDK の利用者には開けない */
const PRIVATE_HOSTS = ["doc", "admin"].map((name) => `${name}.monica.accelhack.net`);

describe("published surface", () => {
  test("追跡しているファイルを実際に読んでいる", async () => {
    const files = await trackedFiles();
    // 呼び出しが壊れて 0 件になると、この検査は黙って何も守らなくなる
    expect(files.length).toBeGreaterThan(30);
    for (const directory of ["core", "node", "cloudflare", "next", "spec"]) {
      expect(files.some((path) => path.startsWith(`${directory}/`)), directory).toBe(true);
    }
  });

  test("非公開の決定ログを番号で引いていない", async () => {
    // 決定ログは非公開の設計サイトの中にある。番号ではなく理由そのものを書く
    const reference = /\bDEC\d+\b/;
    const hits: string[] = [];
    for (const path of await trackedFiles()) {
      const found = (await contentsOf(path)).match(reference);
      if (found) hits.push(`${path}: ${found[0]}`);
    }
    expect(hits).toEqual([]);
  });

  test("非公開の設計サイト・管理画面へリンクしていない", async () => {
    const hits: string[] = [];
    for (const path of await trackedFiles()) {
      const contents = await contentsOf(path);
      for (const host of PRIVATE_HOSTS) {
        if (contents.includes(host)) hits.push(`${path}: ${host}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
