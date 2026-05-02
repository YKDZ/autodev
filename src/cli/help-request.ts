import { logger } from "@/shared/logger.js";

export const runHelpRequest = async (_args: string[]): Promise<void> => {
  logger.error(
    JSON.stringify({ error: "help-request command is currently unavailable" }),
  );
  process.exit(1);
};
