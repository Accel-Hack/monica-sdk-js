import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createCoreClient, createFetchTransport } from "@ah-monica/core";
import { buildItem, environmentFor, extractFailedStepLog, failedStep } from "./build.mjs";

const env = process.env;
const dsn = env.MONICA_DSN?.trim();
if (!dsn) {
  console.log("::warning::MONICA_DSN is empty; nothing was sent to MONICA");
  process.exit(0);
}

const repo = env.GITHUB_REPOSITORY;
const api = env.GITHUB_API_URL || "https://api.github.com";
const headers = {
  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};
const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)
  ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
  : {};
const runId = event.workflow_run?.id ?? env.GITHUB_RUN_ID;

const fetchRepo = (path) => fetch(`${api}/repos/${repo}${path}`, { headers });
const httpError = async (path, response) =>
  new Error(`GET ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);

async function gh(path) {
  const response = await fetchRepo(path);
  if (!response.ok) throw await httpError(path, response);
  return response.json();
}

// A job's log 404s while it runs and for a few seconds after it finishes. Any other failure still
// sends the event without the log, so one unreadable log does not drop every job's event.
async function jobLog(jobId) {
  const path = `/actions/jobs/${jobId}/logs`;
  for (let retry = 0; ; retry++) {
    const response = await fetchRepo(path);
    if (response.ok) return response.text();
    if (response.status !== 404) {
      console.log(`::warning::${(await httpError(path, response)).message}`);
      return null;
    }
    if (retry === 3) return null;
    await sleep(5_000);
  }
}

const run = await gh(`/actions/runs/${runId}`);
// Via workflow_run a fork's run reaches this script with the base repository's secrets, and its job
// names and logs are attacker-controlled.
if (run.head_repository?.full_name !== repo) {
  console.log("::notice::run from a fork; nothing was sent to MONICA");
  process.exit(0);
}
const { default_branch } = await gh("");
const jobs = [];
for (let page = 1; ; page++) {
  const body = await gh(`/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
  jobs.push(...body.jobs);
  if (jobs.length >= body.total_count || body.jobs.length === 0) break;
}

const failed = jobs.filter((job) => job.status === "completed" && ["failure", "timed_out"].includes(job.conclusion));
if (failed.length === 0) {
  console.log("::notice::no failed jobs found");
  process.exit(0);
}

// Fetch every log before the first capture. Otherwise the SDK's background timer can flush an early
// capture while a later log is still loading, and close() does not report whether that send was accepted.
const logs = await Promise.all(failed.map(async (job) => {
  const raw = await jobLog(job.id);
  return raw === null ? null : extractFailedStepLog(raw, failedStep(job));
}));
const client = createCoreClient({
  transport: createFetchTransport({ dsn, auth: "secret", requestTimeoutMs: 10_000 }),
  environment: environmentFor(run, default_branch),
  release: run.head_sha,
  sdk: { name: "Accel-Hack/monica-sdk-js/monica-notify", version: "1.0.0" },
});
for (const [i, job] of failed.entries()) {
  const eventId = await client.capture(buildItem({ repo, run, job, log: logs[i] }));
  console.log(`sent ${job.name} event_id=${eventId}`);
}

// The SDK unrefs its retry timers, so without this Node exits mid-retry with code 13 on a 5xx (#23).
const keepAlive = setTimeout(() => {}, 30_000);
const result = await client.close(30_000);
clearTimeout(keepAlive);
if (!result.accepted) {
  const { status, error, issues } = result;
  console.log(`::error::MONICA did not accept the events ${JSON.stringify({ status, error, issues })}`);
  process.exit(1);
}
