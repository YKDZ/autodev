import { logger } from "../shared/logger.js";

export const runHelpRequest = async (_args: string[]): Promise<void> => {
  logger.out(JSON.stringify({ message: "help-request not yet implemented" }));
};
