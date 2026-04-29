import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

import { logger } from "../shared/logger.js";

export const generateSSHConfig = (): void => {
  const publicKey = process.env.SSH_PUBLIC_KEY;
  const password = process.env.SSH_PASSWORD;

  if (publicKey) {
    mkdirSync("/root/.ssh", { recursive: true });
    writeFileSync("/root/.ssh/authorized_keys", publicKey.trim() + "\n", {
      mode: 0o600,
    });
    logger.info("[auto-dev] SSH public key authorized");
  }

  if (password) {
    execSync(`echo "root:${password}" | chpasswd`);
    logger.info("[auto-dev] SSH password authentication enabled");
  }

  if (!publicKey && !password) {
    logger.warn(
      "[auto-dev] No SSH_PUBLIC_KEY or SSH_PASSWORD set. SSH access unavailable. Use docker exec to enter container.",
    );
  }
};
