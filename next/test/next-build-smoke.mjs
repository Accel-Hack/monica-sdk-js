import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = join(packageRoot, "test", "fixture");
const output = join(fixture, ".next");
const fixturePackage = join(fixture, "node_modules", "@ah-monica", "next");
const fixtureNext = join(fixture, "node_modules", "next");
rmSync(output, { recursive: true, force: true });
rmSync(join(fixture, "node_modules"), { recursive: true, force: true });
mkdirSync(dirname(fixturePackage), { recursive: true });
symlinkSync(packageRoot, fixturePackage, "dir");
symlinkSync(realpathSync(join(packageRoot, "node_modules", "next")), fixtureNext, "dir");

const nextBin = join(packageRoot, "node_modules", "next", "dist", "bin", "next");
const result = spawnSync(process.execPath, [nextBin, "build", fixture], {
  cwd: packageRoot,
  encoding: "utf8",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  timeout: 180_000,
});
if (result.status !== 0) {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const staticDirectory = join(output, "static");
const clientBundle = readFiles(staticDirectory).join("\n");
assert(!clientBundle.includes("node:async_hooks"), "Node AsyncLocalStorage leaked into client bundle");
assert(!clientBundle.includes("msk_build_test"), "server DSN leaked into client bundle");
assert(clientBundle.includes("mpk_build_test"), "client adapter was not included in client bundle");

function readFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? readFiles(path) : [readFileSync(path, "utf8")];
  });
}
