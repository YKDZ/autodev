import type { AutoDevConfig } from "../config/types.js";
import type { PollResult } from "../shared/types.js";

import { parseFrontmatter } from "../shared/frontmatter-parser.js";
import { getReadyLabelAdder, listIssues } from "../shared/gh-cli.js";
import { logger } from "../shared/logger.js";
import { isAllowedUser } from "../shared/user-filter.js";
import { listWorkflowRuns } from "../state-store/index.js";

export class IssueWatcher {
  /**
   * Poll for new issues with the "auto-dev:ready" label.
   * Filters by allowed users and excludes already-claimed issues.
   */
  poll(
    repo: string,
    config: AutoDevConfig,
    workspaceRoot: string,
  ): PollResult[] {
    const activeRuns = listWorkflowRuns(workspaceRoot).filter(
      (r) => !["completed", "failed"].includes(r.status),
    );
    const claimedIssueNumbers = new Set(activeRuns.map((r) => r.issueNumber));

    let issues: ReturnType<typeof listIssues>;
    try {
      issues = listIssues(repo, "auto-dev:ready");
    } catch (err) {
      logger.error(`[auto-dev] Failed to poll issues: ${String(err)}`);
      return [];
    }

    const results: PollResult[] = [];

    for (const issue of issues) {
      const labelAdder = getReadyLabelAdder(repo, issue.number);
      if (!labelAdder || !isAllowedUser(labelAdder)) {
        logger.info(
          `[auto-dev] Skipping issue #${issue.number}: label adder "${labelAdder ?? "unknown"}" is not authorized`,
        );
        continue;
      }

      const labelNames = issue.labels.map((l) =>
        typeof l === "string" ? l : l.name,
      );
      if (labelNames.includes("human-only")) continue;
      if (claimedIssueNumbers.has(issue.number)) continue;

      const bodyFm = parseFrontmatter(issue.body);

      // Resolve agent definition: frontmatter > config default
      const agentDefinition =
        bodyFm?.agent && config.agents[bodyFm.agent]
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
  }
}
