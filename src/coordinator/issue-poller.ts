import type { AutoDevConfig } from "../config/types.js";
import type { PollResult } from "../shared/types.js";

export type { PollResult };

import { logger } from "../shared/logger.js";
import { parseFrontmatter } from "../shared/frontmatter-parser.js";
import { listIssues } from "../shared/gh-cli.js";
import { listWorkflowRuns } from "../state-store/index.js";

export const pollIssues = async (
  repo: string,
  config: AutoDevConfig,
  workspaceRoot: string,
): Promise<PollResult[]> => {
  const activeRuns = listWorkflowRuns(workspaceRoot).filter(
    (r) => !["completed", "failed"].includes(r.status),
  );
  const claimedIssueNumbers = new Set(activeRuns.map((r) => r.issueNumber));

  let issues: Awaited<ReturnType<typeof listIssues>>;
  try {
    issues = listIssues(repo, "auto-dev:ready");
  } catch (err) {
    logger.error(`[auto-dev] Failed to poll Issues: ${String(err)}`);
    return [];
  }

  const results: PollResult[] = [];

  for (const issue of issues) {
    const labelNames = issue.labels.map((l) =>
      typeof l === "string" ? l : l.name,
    );

    if (labelNames.includes("human-only")) continue;
    if (claimedIssueNumbers.has(issue.number)) continue;

    const bodyFm = parseFrontmatter(issue.body);

    // Resolve agent definition: frontmatter > config default
    const agentDefinition = (bodyFm?.agent && config.agents[bodyFm.agent])
      ? bodyFm.agent
      : config.defaultAgent;

    results.push({
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
      agentDefinition,
      agentModel: bodyFm?.model ?? null,
      agentEffort: bodyFm?.effort ?? null,
      maxTurns: bodyFm?.maxTurns ?? null,
    });
  }

  return results;
};
