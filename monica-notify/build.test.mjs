import assert from "node:assert/strict";
import { test } from "node:test";
import { buildItem, environmentFor, eventIdFor, extractFailedStepLog } from "./build.mjs";

const RAW =
  "\uFEFF" +
  [
    "2026-10-09T04:40:29.5000000Z ##[group]Run actions/checkout@v4",
    "2026-10-09T04:40:29.9000000Z checked out",
    "2026-10-09T04:40:30.0985915Z ##[group]Run npm test",
    "2026-10-09T04:40:30.1000000Z \x1b[36;1mnpm test\x1b[0m",
    "2026-10-09T04:40:31.0000000Z ##[group]Run ./nested-composite",
    "2026-10-09T04:40:40.0000000Z ##[error]first error",
    "2026-10-09T04:40:45.5000000Z Error: boom",
    "2026-10-09T04:40:45.9000000Z ##[error]Process completed with exit code 1.",
    "2026-10-09T04:40:45.9500000Z ##[group]Run actions/upload-artifact@v4",
    "2026-10-09T04:40:47.0000000Z ##[error]upload failed",
  ].join("\n");

const STEP = { started_at: "2026-10-09T04:40:30Z", completed_at: "2026-10-09T04:40:45Z" };

test("extractFailedStepLog keeps the failed step up to its last error, without timestamps or ANSI", () => {
  assert.equal(
    extractFailedStepLog(RAW, STEP),
    [
      "##[group]Run npm test",
      "npm test",
      "##[group]Run ./nested-composite",
      "##[error]first error",
      "Error: boom",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
});

test("extractFailedStepLog keeps only the last maxLines lines", () => {
  assert.equal(extractFailedStepLog(RAW, STEP, 2), "Error: boom\n##[error]Process completed with exit code 1.");
});

test("extractFailedStepLog without a step uses the whole log, including the BOM-prefixed first line", () => {
  const lines = extractFailedStepLog(RAW).split("\n");
  assert.equal(lines[0], "##[group]Run actions/checkout@v4");
  assert.equal(lines.at(-1), "##[error]upload failed");
  assert.equal(lines.length, 10);
});

test("extractFailedStepLog caps the result at the last 64 KiB", () => {
  const raw = Array.from({ length: 100 }, (_, i) => `2026-10-09T04:40:30.0000000Z ${i}${"x".repeat(1000)}`).join("\n");
  const text = extractFailedStepLog(raw);
  assert.equal(Buffer.byteLength(text), 65536);
  assert.ok(text.endsWith(`99${"x".repeat(1000)}`));
});

test("eventIdFor is a UUIDv4 derived only from the job id", () => {
  const uuidV4 = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  // sha256("github-actions-job:42") = 0d016b6ff4a020f1480d19013a4842a5...
  assert.equal(eventIdFor(42), "0d016b6f-f4a0-40f1-880d-19013a4842a5");
  assert.equal(eventIdFor(113672352858), eventIdFor(113672352858));
  assert.notEqual(eventIdFor(1), eventIdFor(2));
  for (let id = 0; id < 200; id++) assert.match(eventIdFor(id), uuidV4);
});

test("environmentFor is ci only for a non-PR run on the default branch", () => {
  assert.equal(environmentFor({ event: "push", head_branch: "main" }, "main"), "ci");
  assert.equal(environmentFor({ event: "schedule", head_branch: "main" }, "main"), "ci");
  assert.equal(environmentFor({ event: "pull_request", head_branch: "main" }, "main"), "ci-pr");
  assert.equal(environmentFor({ event: "pull_request_target", head_branch: "main" }, "main"), "ci-pr");
  assert.equal(environmentFor({ event: "push", head_branch: "feature" }, "main"), "ci-pr");
});

const RUN = {
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  head_branch: "fix-x",
  pull_requests: [{ number: 7 }],
};
const JOB = {
  id: 42,
  name: "test",
  html_url: "https://github.com/o/r/actions/runs/1/job/42",
  steps: [
    { name: "checkout", conclusion: "success" },
    { name: "npm test", conclusion: "failure" },
    { name: "upload", conclusion: "failure" },
  ],
};

test("buildItem puts the log first and the title last", () => {
  assert.deepEqual(buildItem({ repo: "o/r", run: RUN, job: JOB, log: "a\nb" }), {
    type: "error",
    event_id: "0d016b6f-f4a0-40f1-880d-19013a4842a5",
    level: "error",
    platform: "node",
    exception: {
      values: [
        {
          type: "Log",
          value: [
            "workflow: CI",
            "branch: fix-x (#7)",
            "step: npm test",
            "",
            "a",
            "b",
          ].join("\n"),
        },
        { type: "JobFailed", value: "[o/r] test https://github.com/o/r/actions/runs/1/job/42" },
      ],
    },
    tags: {
      "gha.repository": "o/r",
      "gha.workflow": "CI",
      "gha.job": "test",
      "gha.event": "pull_request",
      "gha.branch": "fix-x",
      "gha.pull_request": "7",
    },
    fingerprint: ["github-actions", "o/r", ".github/workflows/ci.yml", "test", "fix-x"],
  });
});

test("buildItem without a PR, failed step, or log names the branch and omits the PR tag", () => {
  const run = { ...RUN, event: "push", head_branch: "main", pull_requests: [] };
  const item = buildItem({ repo: "o/r", run, job: { ...JOB, steps: undefined }, log: null });
  assert.equal(item.exception.values.at(-1).value, "[o/r] test https://github.com/o/r/actions/runs/1/job/42");
  assert.equal(
    item.exception.values[0].value,
    "workflow: CI\nbranch: main\n\n(log unavailable)",
  );
  assert.ok(!("gha.pull_request" in item.tags));
  assert.equal(item.fingerprint.at(-1), "main");
});
