import { logger } from "@/shared/logger.js";

export const runAudit = async (_args: string[]): Promise<void> => {
  logger.error(
    JSON.stringify({ error: "audit command is currently unavailable" }),
  );
  process.exit(1);
};
