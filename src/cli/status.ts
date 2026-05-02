import { logger } from "@/shared/logger.js";
import { listWorkflowRuns } from "@/state-store/index.js";

export const runStatus = async (_args: string[]): Promise<void> => {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  const runs = listWorkflowRuns(workspaceRoot);
  logger.json(runs);
};
