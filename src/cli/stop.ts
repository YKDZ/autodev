import { logger } from "@/shared/logger.js";

export const runStop = async (_args: string[]): Promise<void> => {
  logger.error(
    JSON.stringify({ error: "stop command is currently unavailable" }),
  );
  process.exit(1);
};
