import { logger } from "@/shared/logger.js";
import { ensureStateDirs } from "@/state-store/index.js";

import { loadConfig } from "../config/loader.js";
import { DecisionManager } from "../decision-service/decision-manager.js";

export const runDecisions = async (_args: string[]): Promise<void> => {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  await ensureStateDirs(workspaceRoot);
  const config = await loadConfig(workspaceRoot);
  const manager = new DecisionManager(workspaceRoot, config);
  const decisions = manager.listAll();
  logger.json(decisions);
};
