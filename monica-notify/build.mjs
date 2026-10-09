import { createHash } from "node:crypto";

const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z) ?(.*)$/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const MAX_LOG_BYTES = 64 * 1024;

export function environmentFor(run, defaultBranch) {
  return !run.event.startsWith("pull_request") && run.head_branch === defaultBranch ? "ci" : "ci-pr";
}

// MONICA drops a second event with the same (project, event_id), so re-running the notifier does not double count.
export function eventIdFor(jobId) {
  const hex = createHash("sha256").update(`github-actions-job:${jobId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[parseInt(hex[16], 16) & 3];
  return hex.join("").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

export function failedStep(job) {
  return job.steps?.find((step) => step.conclusion === "failure");
}

export function extractFailedStepLog(raw, step, maxLines = 100) {
  // Step times have second precision and log times 100ns, so the step's last second is inclusive.
  const from = step ? Date.parse(step.started_at) : -Infinity;
  const to = step ? Date.parse(step.completed_at) + 1000 : Infinity;
  const lines = [];
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = LOG_LINE.exec(line);
    if (!match) continue;
    const time = Date.parse(match[1]);
    if (time >= from && time < to) lines.push(match[2].replace(ANSI, ""));
  }
  // The window can spill into the next step's first second; the step's own last error marks where it ended.
  const lastError = lines.findLastIndex((line) => line.startsWith("##[error]"));
  const text = (lastError === -1 ? lines : lines.slice(0, lastError + 1)).slice(-maxLines).join("\n");
  return Buffer.from(text).subarray(-MAX_LOG_BYTES).toString();
}

export function buildItem({ repo, run, job, log }) {
  const step = failedStep(job);
  const pr = run.pull_requests?.[0]?.number;
  const branch = run.head_branch ?? "";
  const header = [
    `workflow: ${run.name}`,
    `branch: ${branch}${pr ? ` (#${pr})` : ""}`,
    ...(step ? [`step: ${step.name}`] : []),
  ].join("\n");
  return {
    type: "error",
    event_id: eventIdFor(job.id),
    level: "error",
    platform: "node",
    exception: {
      // MONICA titles the issue from the last value and renders each value in a <pre>, so the title goes last.
      values: [
        { type: "Log", value: `${header}\n\n${log ?? "(log unavailable)"}` },
        { type: "JobFailed", value: `${repo} / ${job.name} ${job.html_url}` },
      ],
    },
    tags: {
      "gha.repository": repo,
      "gha.workflow": run.name,
      "gha.job": job.name,
      "gha.event": run.event,
      "gha.branch": branch,
      ...(pr ? { "gha.pull_request": String(pr) } : {}),
    },
    fingerprint: ["github-actions", repo, run.path, job.name, branch],
  };
}
