import { logger } from "../shared/logger.js";

export const runStop = async (_args: string[]): Promise<void> => {
  logger.out(
    JSON.stringify({ message: "Coordinator stop not yet implemented" }),
  );
};
