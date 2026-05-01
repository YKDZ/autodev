import type { WorkspaceRegistryEntry } from "../shared/types.js";

import { logger } from "../shared/logger.js";
import {
  registerWorkspace,
  findWorkspaceByIssueNumber,
} from "../state-store/index.js";
import { DevcontainerManager } from "./devcontainer-manager.js";
import { GitManager } from "./git-manager.js";

export interface WorkspaceInfo {
  branch: string;
  worktreePath: string;
  containerId: string;
}

export class WorkspaceManager {
  private readonly git: GitManager;
  private readonly devcontainer: DevcontainerManager;
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string, repoFullName: string) {
    this.workspaceRoot = workspaceRoot;
    this.git = new GitManager(workspaceRoot, repoFullName);
    this.devcontainer = new DevcontainerManager(workspaceRoot);
  }

  getGitManager(): GitManager {
    return this.git;
  }

  /**
   * Full lifecycle: create branch, worktree, start devcontainer.
   */
  async create(issueNumber: number, runId: string): Promise<WorkspaceInfo> {
    const { branch, worktreePath } = this.git.createBranch(issueNumber);

    logger.info(
      `[auto-dev] Starting devcontainer for worktree ${worktreePath}...`,
    );
    const containerId = this.devcontainer.start(worktreePath);

    const entry: WorkspaceRegistryEntry = {
      issueNumber,
      runId,
      worktreePath,
      containerId,
      branch,
      createdAt: new Date().toISOString(),
    };
    await registerWorkspace(this.workspaceRoot, entry);

    return { branch, worktreePath, containerId };
  }

  /**
   * Ensure worktree and container exist (for re-trigger).
   * Creates them if missing.
   */
  async ensure(
    issueNumber: number,
    runId: string,
    branch: string,
  ): Promise<WorkspaceInfo> {
    const worktreePath = `${this.workspaceRoot}/tools/auto-dev/worktrees/issue-${issueNumber}`;

    this.git.ensureWorktree(branch, worktreePath);

    let containerId = "";
    const existing = findWorkspaceByIssueNumber(
      this.workspaceRoot,
      issueNumber,
    );
    if (existing && this.devcontainer.isRunning(existing.containerId)) {
      containerId = existing.containerId;
    } else {
      containerId = this.devcontainer.start(worktreePath);
    }

    const entry: WorkspaceRegistryEntry = {
      issueNumber,
      runId,
      worktreePath,
      containerId,
      branch,
      createdAt: new Date().toISOString(),
    };
    await registerWorkspace(this.workspaceRoot, entry);

    return { branch, worktreePath, containerId };
  }

  /**
   * Destroy workspace: stop container, remove worktree, clean up registry.
   */
  async destroy(info: WorkspaceInfo): Promise<void> {
    this.devcontainer.stop(info.containerId);
    this.git.removeWorktree(info.worktreePath);
  }
}
