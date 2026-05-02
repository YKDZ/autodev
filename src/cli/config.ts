import { logger } from "@/shared/logger.js";

import { loadConfig } from "../config/loader.js";

export const runConfig = async (_args: string[]): Promise<void> => {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  const config = await loadConfig(workspaceRoot);
  logger.json(config);
};
