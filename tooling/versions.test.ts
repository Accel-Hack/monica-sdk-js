/**
 * 4 package の版が揃っているか。リリースは一括なので、package.json の version、
 * package 間依存の pin、src の SDK_VERSION がすべて同じ値でなければならない。
 * npm-release.yml も tag と照合するが、そこまで行く前に手元と PR の CI で落とす。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { PACKAGES, ROOT, VERSION_FILES } from "./set-version.js";

function manifest(name: string) {
  return JSON.parse(readFileSync(resolve(ROOT, name, "package.json"), "utf8")) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
  };
}

describe("versions", () => {
  const core = manifest("core").version;

  test("4 package の version が同じ", () => {
    for (const name of PACKAGES) expect(manifest(name).version, name).toBe(core);
  });

  test("package 間依存は同じ版に pin されている", () => {
    for (const name of PACKAGES) {
      for (const [dependency, range] of Object.entries(manifest(name).dependencies ?? {})) {
        if (dependency.startsWith("@ah-monica/")) expect(range, `${name} → ${dependency}`).toBe(core);
      }
    }
  });

  test("src の SDK_VERSION が package.json と同じ", () => {
    for (const name of PACKAGES) {
      const source = readFileSync(resolve(ROOT, VERSION_FILES[name]), "utf8");
      const found = /SDK_VERSION = "([^"]+)"/.exec(source);
      expect(found?.[1], VERSION_FILES[name]).toBe(core);
    }
  });
});
