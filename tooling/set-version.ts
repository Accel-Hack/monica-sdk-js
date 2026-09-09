/**
 * 4 package の version を同じ値に揃える。
 *
 *   bun run version 0.2.0
 *
 * 書き換えるのは package.json の version、package 間依存の pin、各 package の
 * 各 package の version.ts（VERSION_FILES）の SDK_VERSION。リリースは 4 package を同じ版で一括して行う
 * （npm-release.yml が tag と 4 つの version の一致を検証する）ので、版はここ以外で
 * 触らない。ズレは tooling/versions.test.ts が落とす。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const PACKAGES = ["core", "node", "cloudflare", "next"] as const;
export const VERSION_FILES: Record<(typeof PACKAGES)[number], string> = {
  core: "core/src/version.ts",
  node: "node/src/version.ts",
  cloudflare: "cloudflare/src/version.ts",
  next: "next/src/client/version.ts",
};
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function setVersion(version: string): string[] {
  if (!SEMVER.test(version)) throw new Error(`version が semver ではない: ${version}`);
  const touched: string[] = [];

  // 8 ファイル全部を書き込む前に検証する。途中で throw すると、一部の package だけ版が
  // 上がった不整合な状態でツリーが残る
  for (const name of PACKAGES) {
    const versionFile = resolve(ROOT, VERSION_FILES[name]);
    if (!/SDK_VERSION = "/.test(readFileSync(versionFile, "utf8"))) {
      throw new Error(`${VERSION_FILES[name]} に SDK_VERSION が無い`);
    }
    const manifest = readFileSync(resolve(ROOT, name, "package.json"), "utf8");
    if (!/"version": "[^"]+"/.test(manifest)) throw new Error(`${name}/package.json に version が無い`);
  }

  for (const name of PACKAGES) {
    const path = resolve(ROOT, name, "package.json");
    // 手書きの整形（1 行配列など）を保つため、JSON を parse し直さず文字列置換にする
    const source = readFileSync(path, "utf8");
    let next = source.replace(/"version": "[^"]+"/, `"version": "${version}"`);
    next = next.replace(/"(@ah-monica\/[a-z]+)": "[^"]+"/g, `"$1": "${version}"`);
    if (next !== source) writeFileSync(path, next);
    touched.push(`${name}/package.json`);

    const versionFile = resolve(ROOT, VERSION_FILES[name]);
    const before = readFileSync(versionFile, "utf8");
    const after = before.replace(/SDK_VERSION = "[^"]+"/, `SDK_VERSION = "${version}"`);
    if (after !== before) writeFileSync(versionFile, after);
    touched.push(VERSION_FILES[name]);
  }
  return touched;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("使い方: bun run version X.Y.Z");
    process.exit(2);
  }
  for (const path of setVersion(version)) console.log(path);
  console.log(`4 package を ${version} にした。bun install で bun.lock を更新してから commit する`);
}
