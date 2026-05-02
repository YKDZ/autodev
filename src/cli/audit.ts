import { logger } from "@/shared/logger.js";

export const runAudit = async (_args: string[]): Promise<void> => {
  logger.out(JSON.stringify({ message: "audit not yet implemented" }));
};
