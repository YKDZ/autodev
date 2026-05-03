import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { getAuthEnv } from "@/shared/github-app-auth.js";
import { logger } from "@/shared/logger.js";

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

  async ensureRepo(): Promise<void> {
    const token = getAuthEnv().GITHUB_TOKEN;
    const authedUrl = `https://x-access-token:${token}@github.com/${this.repoFullName}.git`;
    if (!existsSync(resolve(this.workspaceRoot, ".git"))) {
      logger.info("[auto-dev] Cloning repository...");
      execFileSync(
        "git",
        ["clone", authedUrl, this.workspaceRoot, "--depth=1"],
        {
          stdio: "pipe",
        },
      );
    } else {
      logger.info("[auto-dev] Fetching origin/main...");
      // Always update remote URL with current token (token rotates each hour)
      git(["remote", "set-url", "origin", authedUrl], this.workspaceRoot);
      await this.fetchWithRetry();
    }
    // Configure git identity
    git(
      ["config", "user.email", "auto-dev[bot]@users.noreply.github.com"],
      this.workspaceRoot,
    );
    git(["config", "user.name", "Auto-Dev Bot"], this.workspaceRoot);

    // Disable git-lfs and other client-side hooks for orchestrator operations.
    // The orchestrator container does not have git-lfs installed; hooks would
    // abort worktree add / push commands with an error.
    const emptyHooksDir = resolve(this.workspaceRoot, ".git", "no-hooks");
    try {
      mkdirSync(emptyHooksDir, { recursive: true });
      git(["config", "core.hooksPath", emptyHooksDir], this.workspaceRoot);
    } catch {
      /* best-effort */
    }
  }

  getRepoRoot(): string {
    return this.workspaceRoot;
  }

  private async fetchWithRetry(): Promise<void> {
    return this.fetchBranchWithRetry("main");
  }

  private async fetchBranchWithRetry(branch: string): Promise<void> {
    const delaysMs = [1_000, 2_000, 4_000];
    let lastError: Error | null = null;

    for (let i = 0; i <= delaysMs.length; i += 1) {
      try {
        gitWithAuth(["fetch", "origin", branch], this.workspaceRoot);
        git(["rev-parse", "--verify", `origin/${branch}`], this.workspaceRoot);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < delaysMs.length) {
          logger.warn(
            `[auto-dev] git fetch origin/${branch} failed (attempt ${i + 1}/3): ${lastError.message}. Retrying in ${delaysMs[i] / 1000}s...`,
          );
          // oxlint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
        }
      }
    }
    throw new Error(
      `Failed to fetch origin/${branch} after 3 retries: ${lastError?.message ?? "unknown error"}`,
    );
  }

  private remoteBranchExists(branch: string): boolean {
    const output = gitWithAuth(
      ["ls-remote", "--heads", "origin", branch],
      this.workspaceRoot,
    );
    return output.trim().length > 0;
  }

  private getRemoteHead(branch: string): string | null {
    try {
      gitWithAuth(["fetch", "origin", branch], this.workspaceRoot);
    } catch {
      return null;
    }

    try {
      return git(["rev-parse", `origin/${branch}`], this.workspaceRoot);
    } catch {
      return null;
    }
  }

  async createBranch(
    issueNumber: number,
    baseBranch = "main",
  ): Promise<{ branch: string; worktreePath: string }> {
    const branch = `auto-dev/issue-${issueNumber}`;
    const worktreePath = resolve(
      this.workspaceRoot,
      "tools/auto-dev/worktrees",
      `issue-${issueNumber}`,
    );

    await this.fetchBranchWithRetry(baseBranch);

    // Recreate local branch to track existing remote branch when present,
    // otherwise create from configured base branch.
    try {
      git(["branch", "-D", branch], this.workspaceRoot);
    } catch {
      /* branch didn't exist */
    }

    if (this.remoteBranchExists(branch)) {
      git(["branch", branch, `origin/${branch}`], this.workspaceRoot);
    } else {
      git(["branch", branch, `origin/${baseBranch}`], this.workspaceRoot);
    }

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
      const token = getAuthEnv().GITHUB_TOKEN;
      const authedUrl = `https://x-access-token:${token}@github.com/${this.repoFullName}.git`;
      git(["remote", "set-url", "origin", authedUrl], worktreePath);
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
    if (existsSync(worktreePath)) {
      // Worktree exists — sync with remote if branch is already pushed
      try {
        gitWithAuth(["fetch", "origin", branch], this.workspaceRoot);
        try {
          git(["reset", "--hard", `origin/${branch}`], worktreePath);
        } catch {
          /* remote branch doesn't exist yet — keep local state */
        }
      } catch {
        /* network failure or branch not on remote — keep local state */
      }
      return;
    }

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

  /**
   * Sync worktree to latest remote branch state.
   * Force-resets local worktree to match origin/<branch>.
   * Safe to call before each agent invocation.
   */
  syncWorktree(branch: string, worktreePath: string): void {
    // Discard uncommitted local changes
    try {
      git(["reset", "--hard", "HEAD"], worktreePath);
      git(["clean", "-fd"], worktreePath);
    } catch {
      /* best-effort */
    }

    // Fetch latest from remote
    try {
      gitWithAuth(["fetch", "origin", branch], this.workspaceRoot);
    } catch {
      // Branch may not exist remotely yet (before create-pr)
      return;
    }

    // Reset to match remote exactly
    try {
      git(["reset", "--hard", `origin/${branch}`], worktreePath);
    } catch {
      // Branch exists locally but not on remote — that's fine
    }
  }

  removeWorktree(worktreePath: string): void {
    try {
      git(["worktree", "remove", "--force", worktreePath], this.workspaceRoot);
    } catch {
      /* best-effort */
    }
  }

  async commitAndPush(
    branch: string,
    message: string,
    cwd?: string,
  ): Promise<{ pushedSha: string | null; observedRemoteSha: string | null }> {
    const dir = cwd ?? this.workspaceRoot;
    git(["add", "-A"], dir);
    try {
      git(["commit", "--allow-empty", "-m", message], dir);
    } catch {
      /* nothing to commit */
    }
    // Refresh remote URL with current token before pushing (token rotates hourly)
    try {
      const token = getAuthEnv().GITHUB_TOKEN;
      const authedUrl = `https://x-access-token:${token}@github.com/${this.repoFullName}.git`;
      git(["remote", "set-url", "origin", authedUrl], dir);
    } catch {
      /* best-effort: may fail if dir has no remote */
    }
    // Retry push with backoff for transient network failures, protecting
    // against accidental overwrite by using --force-with-lease.
    const delaysMs = [5_000, 10_000, 20_000];
    for (let i = 0; i <= delaysMs.length; i += 1) {
      try {
        const observedRemoteSha = this.getRemoteHead(branch);
        const pushArgs = observedRemoteSha
          ? [
              "push",
              "--no-verify",
              `--force-with-lease=refs/heads/${branch}:${observedRemoteSha}`,
              "-u",
              "origin",
              `${branch}:${branch}`,
            ]
          : ["push", "--no-verify", "-u", "origin", `${branch}:${branch}`];

        gitWithAuth(pushArgs, dir, {
          GIT_HTTP_LOW_SPEED_TIME: "20",
          GIT_HTTP_LOW_SPEED_LIMIT: "1000",
        });
        const pushedSha = git(["rev-parse", "HEAD"], dir);
        return { pushedSha, observedRemoteSha };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (i < delaysMs.length) {
          logger.warn(
            `[auto-dev] git push failed (attempt ${i + 1}/${delaysMs.length}), retrying in ${delaysMs[i] / 1000}s: ${message}`,
          );
          // oxlint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
        } else {
          throw new Error(
            `git push failed after ${delaysMs.length + 1} attempts: ${message}`,
          );
        }
      }
    }

    return { pushedSha: null, observedRemoteSha: null };
  }

  async tryPush(
    branch: string,
    worktreePath: string,
    maxAttempts = 5,
  ): Promise<boolean> {
    const delaysMs = [5_000, 10_000, 20_000, 40_000, 80_000];
    for (let i = 0; i < Math.min(maxAttempts, delaysMs.length); i += 1) {
      try {
        const observedRemoteSha = this.getRemoteHead(branch);
        const pushArgs = observedRemoteSha
          ? [
              "push",
              "--no-verify",
              `--force-with-lease=refs/heads/${branch}:${observedRemoteSha}`,
              "origin",
              `${branch}:${branch}`,
            ]
          : ["push", "--no-verify", "origin", `${branch}:${branch}`];

        gitWithAuth(pushArgs, worktreePath);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[auto-dev] tryPush attempt ${i + 1}/${maxAttempts} failed for ${branch}: ${message}`,
        );
        if (i >= Math.min(maxAttempts, delaysMs.length) - 1) break;
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
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
