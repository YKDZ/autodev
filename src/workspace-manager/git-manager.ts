import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { logger } from "../shared/logger.js";
import { getAuthEnv } from "../shared/github-app-auth.js";

const git = (args: string[], cwd: string): string => {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git error (${args[0]}): ${message}`);
  }
};

export class GitManager {
  private readonly workspaceRoot: string;
  private readonly repoFullName: string;

  constructor(workspaceRoot: string, repoFullName: string) {
    this.workspaceRoot = workspaceRoot;
    this.repoFullName = repoFullName;
  }

  ensureRepo(): void {
    if (!existsSync(resolve(this.workspaceRoot, ".git"))) {
      logger.info("[auto-dev] Cloning repository...");
      const token = getAuthEnv().GITHUB_TOKEN;
      const url = `https://x-access-token:${token}@github.com/${this.repoFullName}.git`;
      execSync(`git clone "${url}" "${this.workspaceRoot}" --depth=1`, {
        stdio: "pipe",
      });
    } else {
      logger.info("[auto-dev] Fetching origin/main...");
      this.fetchWithRetry();
    }
    // Configure git identity
    git(["config", "user.email", "auto-dev[bot]@users.noreply.github.com"], this.workspaceRoot);
    git(["config", "user.name", "Auto-Dev Bot"], this.workspaceRoot);
  }

  getRepoRoot(): string {
    return this.workspaceRoot;
  }

  private fetchWithRetry(): void {
    const delaysSec = [1, 2, 4];
    let lastError: Error | null = null;

    for (let i = 0; i <= delaysSec.length; i += 1) {
      try {
        git(["fetch", "origin", "main"], this.workspaceRoot);
        git(["rev-parse", "--verify", "origin/main"], this.workspaceRoot);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < delaysSec.length) {
          logger.warn(
            `[auto-dev] git fetch origin main failed (attempt ${i + 1}/3): ${lastError.message}. Retrying in ${delaysSec[i]}s...`,
          );
          execSync(`sleep ${delaysSec[i]}`);
        }
      }
    }
    throw new Error(
      `Failed to fetch origin/main after 3 retries: ${lastError?.message ?? "unknown error"}`,
    );
  }

  createBranch(issueNumber: number): { branch: string; worktreePath: string } {
    const branch = `auto-dev/issue-${issueNumber}`;
    const worktreePath = resolve(
      this.workspaceRoot,
      "tools/auto-dev/worktrees",
      `issue-${issueNumber}`,
    );

    this.fetchWithRetry();

    // Delete local branch if it exists (from a previous failed run)
    try {
      git(["branch", "-D", branch], this.workspaceRoot);
    } catch {
      /* branch didn't exist */
    }
    // Delete remote branch
    try {
      git(["push", "origin", "--delete", branch], this.workspaceRoot);
    } catch {
      /* remote branch didn't exist */
    }
    git(["branch", branch, "origin/main"], this.workspaceRoot);

    // Remove stale worktree path if it exists
    try {
      git(["worktree", "remove", "--force", worktreePath], this.workspaceRoot);
    } catch {
      /* no stale worktree */
    }
    git(["worktree", "add", worktreePath, branch], this.workspaceRoot);

    return { branch, worktreePath };
  }

  ensureWorktree(branch: string, worktreePath: string): void {
    if (existsSync(worktreePath)) return;

    try {
      git(["fetch", "origin", branch], this.workspaceRoot);
    } catch {
      /* branch may be local-only */
    }

    try {
      git(["worktree", "prune"], this.workspaceRoot);
    } catch {
      /* best-effort */
    }

    git(["worktree", "add", worktreePath, branch], this.workspaceRoot);
  }

  removeWorktree(worktreePath: string): void {
    try {
      git(["worktree", "remove", "--force", worktreePath], this.workspaceRoot);
    } catch {
      /* best-effort */
    }
  }

  commitAndPush(branch: string, message: string, cwd?: string): void {
    const dir = cwd ?? this.workspaceRoot;
    git(["add", "-A"], dir);
    git(["commit", "-m", message], dir);
    git(["push", "-u", "origin", branch], dir);
  }

  tryPush(branch: string, worktreePath: string): boolean {
    try {
      git(
        ["push", "--force-with-lease", "origin", `${branch}:${branch}`],
        worktreePath,
      );
      return true;
    } catch {
      return false;
    }
  }

  mergeBaseCheck(issueNumber: number): { branch: string; mergeBase: string } {
    const branch = `auto-dev/issue-${issueNumber}`;
    const mergeBase = git(["merge-base", branch, "origin/main"], this.workspaceRoot);
    const mainHead = git(["rev-parse", "origin/main"], this.workspaceRoot);
    if (mergeBase !== mainHead) {
      throw new Error(
        `Branch ${branch} was NOT created from current origin/main.\n` +
          `  merge-base: ${mergeBase.slice(0, 8)}\n  origin/main: ${mainHead.slice(0, 8)}`,
      );
    }
    return { branch, mergeBase };
  }

  isClean(): boolean {
    const status = git(["status", "--porcelain"], this.workspaceRoot);
    return status === "";
  }

  hasConflicts(): boolean {
    try {
      const diff = git(["diff", "--name-only", "--diff-filter=U"], this.workspaceRoot);
      return diff !== "";
    } catch {
      return false;
    }
  }
}
