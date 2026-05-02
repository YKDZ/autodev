import { logger } from "@/shared/logger.js";

export const runRequestValidation = async (_args: string[]): Promise<void> => {
  logger.out(
    JSON.stringify({ message: "request-validation not yet implemented" }),
  );
};
