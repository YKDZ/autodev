import { basename } from "node:path";

import type { WorkspaceRegistryEntry } from "@/shared/types.js";

import { logger } from "@/shared/logger.js";
import {
  registerWorkspace,
  findWorkspaceByIssueNumber,
} from "@/state-store/index.js";

import { DevcontainerManager } from "./devcontainer-manager.js";
import { GitManager } from "./git-manager.js";

export interface WorkspaceInfo {
  branch: string;
  worktreePath: string;
  containerId: string;
  /** Working directory inside the devcontainer (e.g. /workspaces/issue-37). Empty when no container. */
  remoteWorkspaceFolder: string;
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
    return this.createFromBase(issueNumber, runId, "main");
  }

  async createFromBase(
    issueNumber: number,
    runId: string,
    baseBranch: string,
  ): Promise<WorkspaceInfo> {
    const { branch, worktreePath } = await this.git.createBranch(
      issueNumber,
      baseBranch,
    );

    logger.info(
      `[auto-dev] Starting devcontainer for worktree ${worktreePath}...`,
    );
    const { containerId, remoteWorkspaceFolder, containerSource, image } =
      this.devcontainer.startWithMetadata(worktreePath, {
        runId,
        issueNumber,
        branch,
      });

    const entry: WorkspaceRegistryEntry = {
      issueNumber,
      runId,
      worktreePath,
      containerId,
      remoteWorkspaceFolder,
      containerSource,
      image,
      branch,
      createdAt: new Date().toISOString(),
    };
    await registerWorkspace(this.workspaceRoot, entry);

    return { branch, worktreePath, containerId, remoteWorkspaceFolder };
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
    let remoteWorkspaceFolder = "";
    let containerSource: "devcontainer" | "fallback" = "devcontainer";
    let image: string | null = null;
    const existing = findWorkspaceByIssueNumber(
      this.workspaceRoot,
      issueNumber,
    );
    if (existing && this.devcontainer.isRunning(existing.containerId)) {
      containerId = existing.containerId;
      if (existing.remoteWorkspaceFolder) {
        remoteWorkspaceFolder = existing.remoteWorkspaceFolder;
      } else {
        remoteWorkspaceFolder = `/workspaces/${basename(worktreePath)}`;
      }
      containerSource = existing.containerSource;
      image = existing.image;
    } else {
      const result = this.devcontainer.startWithMetadata(worktreePath, {
        runId,
        issueNumber,
        branch,
      });
      containerId = result.containerId;
      remoteWorkspaceFolder = result.remoteWorkspaceFolder;
      containerSource = result.containerSource;
      image = result.image;
    }

    const entry: WorkspaceRegistryEntry = {
      issueNumber,
      runId,
      worktreePath,
      containerId,
      remoteWorkspaceFolder,
      containerSource,
      image,
      branch,
      createdAt: new Date().toISOString(),
    };
    await registerWorkspace(this.workspaceRoot, entry);

    return { branch, worktreePath, containerId, remoteWorkspaceFolder };
  }

  /**
   * Destroy workspace: stop container, remove worktree, clean up registry.
   */
  async destroy(info: WorkspaceInfo): Promise<void> {
    this.devcontainer.stop(info.containerId);
    this.git.removeWorktree(info.worktreePath);
  }
}
