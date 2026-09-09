const port = 8798;
const origin = `http://127.0.0.1:${port}`;

const runtime = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--config",
    "test/wrangler.toml",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, CI: "true" },
    stdout: "inherit",
    stderr: "inherit",
  },
);

async function waitForRuntime(): Promise<Response> {
  let lastProblem = "no response";
  // A cold Wrangler/workerd start can exceed 15 seconds on CI and on a
  // fresh dependency cache. Keep the smoke bounded, but allow 30 seconds.
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    if (runtime.exitCode !== null) {
      throw new Error(`wrangler dev exited during startup: ${runtime.exitCode}`);
    }
    try {
      return await fetch(origin);
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(`wrangler dev did not start: ${lastProblem}`);
}

try {
  const response = await waitForRuntime();
  if (!response.ok) throw new Error(`runtime smoke returned HTTP ${response.status}`);
  const result = (await response.json()) as {
    eventId?: unknown;
    authorization?: unknown;
    encoding?: unknown;
    message?: unknown;
  };
  if (
    typeof result.eventId !== "string" ||
    result.authorization !== "Bearer msk_smoke" ||
    result.encoding !== "gzip" ||
    result.message !== "runtime smoke"
  ) {
    throw new Error(`unexpected runtime result: ${JSON.stringify(result)}`);
  }
  console.log("Cloudflare runtime smoke: capture / gzip / auth / flush OK");
} finally {
  if (runtime.exitCode === null) runtime.kill();
  await runtime.exited;
}
