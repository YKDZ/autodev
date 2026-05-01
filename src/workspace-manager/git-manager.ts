import { execFileSync, execSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { getAuthEnv } from "../shared/github-app-auth.js";
import { logger } from "../shared/logger.js";

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

/** Run git with GitHub App auth env injected (for push/fetch).
 *  Optionally merge additional env vars (e.g. GIT_HTTP_LOW_SPEED_TIME). */
const gitWithAuth = (
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): string => {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      cwd,
      env: { ...process.env, ...getAuthEnv(), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    let stderr = "";
    if (err && typeof err === "object" && "stderr" in err) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const stderrVal = (err as { stderr: Buffer }).stderr;
      stderr = stderrVal.toString().trim();
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `git error (${args[0]}): ${message}${stderr ? `\nstderr: ${stderr}` : ""}`,
    );
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
    git(
      ["config", "user.email", "auto-dev[bot]@users.noreply.github.com"],
      this.workspaceRoot,
    );
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
      gitWithAuth(["push", "origin", "--delete", branch], this.workspaceRoot);
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

    // Propagate the authenticated remote URL to the worktree so that
    // git push from the worktree (e.g. by the agent) uses the correct auth.
    try {
      const remoteUrl = git(
        ["remote", "get-url", "origin"],
        this.workspaceRoot,
      );
      git(["remote", "set-url", "origin", remoteUrl], worktreePath);
    } catch {
      /* worktree inherits from parent; best-effort */
    }

    // Prevent .auto-dev-init-* marker files from being tracked in the worktree
    try {
      const worktreeGitDir = git(["rev-parse", "--git-dir"], worktreePath);
      appendFileSync(
        resolve(worktreeGitDir, "info/exclude"),
        "\n# Auto-Dev temporary files\n.auto-dev-init-*\n",
      );
    } catch {
      /* best-effort */
    }

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
    try {
      git(["commit", "--allow-empty", "-m", message], dir);
    } catch {
      /* nothing to commit */
    }
    // Retry push with backoff for transient network failures.
    // Use --force to handle cases where the remote branch already exists.
    const delaysSec = [5, 10, 20];
    for (let i = 0; i <= delaysSec.length; i += 1) {
      try {
        gitWithAuth(["push", "--force", "-u", "origin", branch], dir, {
          GIT_HTTP_LOW_SPEED_TIME: "20",
          GIT_HTTP_LOW_SPEED_LIMIT: "1000",
        });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (i < delaysSec.length) {
          logger.warn(
            `[auto-dev] git push failed (attempt ${i + 1}/${delaysSec.length}), retrying in ${delaysSec[i]}s: ${message}`,
          );
          execSync(`sleep ${delaysSec[i]}`);
        } else {
          throw new Error(
            `git push failed after ${delaysSec.length + 1} attempts: ${message}`,
          );
        }
      }
    }
  }

  tryPush(branch: string, worktreePath: string, maxAttempts = 5): boolean {
    const delaysSec = [5, 10, 20, 40, 80];
    for (let i = 0; i < Math.min(maxAttempts, delaysSec.length); i += 1) {
      try {
        gitWithAuth(
          ["push", "--force", "origin", `${branch}:${branch}`],
          worktreePath,
        );
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[auto-dev] tryPush attempt ${i + 1}/${maxAttempts} failed for ${branch}: ${message}`,
        );
        if (i >= Math.min(maxAttempts, delaysSec.length) - 1) break;
        execSync(`sleep ${delaysSec[i]}`);
      }
    }
    return false;
  }

  mergeBaseCheck(issueNumber: number): { branch: string; mergeBase: string } {
    const branch = `auto-dev/issue-${issueNumber}`;
    const mergeBase = git(
      ["merge-base", branch, "origin/main"],
      this.workspaceRoot,
    );
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
      const diff = git(
        ["diff", "--name-only", "--diff-filter=U"],
        this.workspaceRoot,
      );
      return diff !== "";
    } catch {
      return false;
    }
  }
}
