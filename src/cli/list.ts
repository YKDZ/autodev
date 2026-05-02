import { logger } from "@/shared/logger.js";
import { listWorkflowRuns } from "@/state-store/index.js";

export const runList = async (_args: string[]): Promise<void> => {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  const runs = listWorkflowRuns(workspaceRoot);
  for (const run of runs) {
    logger.out(
      `#${run.issueNumber} [${run.status}] ${run.branch} (${run.id.slice(0, 8)})`,
    );
  }
  if (runs.length === 0) {
    logger.out("No active runs.");
  }
};
