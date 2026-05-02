import { execFileSync, execSync } from "node:child_process";
import { parseArgs } from "node:util";

import { logger } from "../shared/logger.js";

interface CheckRun {
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | skipped | null
  detailsUrl: string;
  workflowName?: string;
}

interface CIStatus {
  configured: boolean;
  pending: boolean;
  success: boolean;
  failed: boolean;
  runs: CheckRun[];
  summary: string;
}

const getRepoFromEnv = (): string => {
  const repo = process.env.GITHUB_REPOSITORY ?? process.env.GH_REPO;
  if (!repo) {
    throw new Error(
      "Repository not found. Set GITHUB_REPOSITORY or use --repo.",
    );
  }
  return repo;
};

const fetchCheckRuns = (prNumber: number, repo: string): CheckRun[] => {
  // Get the HEAD SHA of the PR
  const sha = execFileSync(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "headRefOid",
      "--jq",
      ".headRefOid",
    ],
    { encoding: "utf-8" },
  ).trim();

  if (!sha) {
    return [];
  }

  // List check runs for the commit
  const output = execFileSync(
    "gh",
    [
      "api",
      `repos/${repo}/commits/${sha}/check-runs`,
      "--paginate",
      "--jq",
      ".check_runs[] | {name, status, conclusion, detailsUrl: .details_url}",
    ],
    { encoding: "utf-8" },
  ).trim();

  if (!output) {
    return [];
  }

  const runs: CheckRun[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    try {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      runs.push(JSON.parse(line) as CheckRun);
    } catch {
      /* skip malformed lines */
    }
  }
  return runs;
};

const buildStatus = (runs: CheckRun[]): CIStatus => {
  if (runs.length === 0) {
    return {
      configured: false,
      pending: false,
      success: false,
      failed: false,
      runs: [],
      summary: "No CI configured",
    };
  }

  const pending = runs.some(
    (r) => r.status === "queued" || r.status === "in_progress",
  );
  const failedRuns = runs.filter(
    (r) =>
      r.status === "completed" &&
      r.conclusion !== "success" &&
      r.conclusion !== "skipped" &&
      r.conclusion !== "neutral",
  );
  const allDone = runs.every((r) => r.status === "completed");
  const success = allDone && failedRuns.length === 0;

  let summary: string;
  if (pending) {
    const inProgress = runs.filter((r) => r.status === "in_progress").length;
    const queued = runs.filter((r) => r.status === "queued").length;
    summary = `CI running: ${inProgress} in progress, ${queued} queued`;
  } else if (success) {
    summary = `All ${runs.length} CI checks passed`;
  } else {
    const failedNames = failedRuns.map((r) => r.name).join(", ");
    summary = `CI failed: ${failedRuns.length}/${runs.length} checks failed (${failedNames})`;
  }

  return {
    configured: true,
    pending,
    success,
    failed: failedRuns.length > 0,
    runs,
    summary,
  };
};

export const runCIStatus = async (args: string[]): Promise<void> => {
  const { values } = parseArgs({
    args,
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      wait: { type: "boolean", default: false },
      timeout: { type: "string" },
      interval: { type: "string" },
    },
    strict: true,
  });

  const prEnv = process.env.AUTO_DEV_PR_NUMBER ?? process.env.GH_PR_NUMBER;
  const rawPr = values.pr ?? prEnv;
  if (!rawPr) {
    logger.error(
      "PR number required. Use --pr <number> or set AUTO_DEV_PR_NUMBER.",
    );
    process.exit(1);
  }
  const prNumber = parseInt(rawPr, 10);
  if (Number.isNaN(prNumber) || prNumber <= 0) {
    logger.error(`Invalid PR number: ${rawPr}`);
    process.exit(1);
  }

  const repo = values.repo ?? getRepoFromEnv();
  const shouldWait = values.wait ?? false;
  const timeoutSec = values.timeout ? parseInt(values.timeout, 10) : 300;
  const intervalSec = values.interval ? parseInt(values.interval, 10) : 10;

  const deadline = shouldWait ? Date.now() + timeoutSec * 1000 : 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let runs: CheckRun[];
    try {
      runs = fetchCheckRuns(prNumber, repo);
    } catch (err) {
      logger.error(`Failed to fetch CI status: ${String(err)}`);
      process.exit(1);
    }

    const status = buildStatus(runs);

    if (!shouldWait || !status.pending) {
      process.stdout.write(JSON.stringify(status, null, 2) + "\n");

      if (status.failed) {
        // Print details about failing checks for agent consumption
        for (const run of status.runs) {
          if (
            run.status === "completed" &&
            run.conclusion !== "success" &&
            run.conclusion !== "skipped" &&
            run.conclusion !== "neutral"
          ) {
            logger.error(
              `  FAILED: ${run.name} (${run.conclusion}) — ${run.detailsUrl}`,
            );
          }
        }
        process.exit(1);
      }

      process.exit(0);
    }

    // Still pending — check timeout
    if (Date.now() >= deadline) {
      const timedOut: CIStatus = {
        ...status,
        pending: false,
        failed: true,
        summary: `CI timed out after ${timeoutSec}s — still pending`,
      };
      process.stdout.write(JSON.stringify(timedOut, null, 2) + "\n");
      process.exit(1);
    }

    logger.info(`[ci-status] ${status.summary} — waiting ${intervalSec}s...`);

    // oxlint-disable-next-line eslint/no-await-in-loop
    await new Promise<void>((resolve) =>
      setTimeout(resolve, intervalSec * 1000),
    );
  }
};

// Fallback: try gh run list for workflows on the PR branch when check-runs is unavailable
export const _getWorkflowRunsForPR = (
  prNumber: number,
  repo: string,
): string => {
  try {
    return execSync(
      `gh run list --repo ${repo} --json name,status,conclusion,url --limit 20`,
      { encoding: "utf-8" },
    ).trim();
  } catch {
    return "[]";
  }
};
