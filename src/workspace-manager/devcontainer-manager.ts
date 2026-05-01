/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- devcontainer CLI JSON and Docker error objects */
import { execFileSync, execSync } from "node:child_process";
import { basename } from "node:path";

import { logger } from "../shared/logger.js";

export class DevcontainerManager {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Start a devcontainer for the given worktree path.
   * Returns { containerId, remoteWorkspaceFolder } or empty strings if the container
   * could not be started (caller should fall back to local execution).
   *
   * The decision server address is injected via env vars (AUTO_DEV_DECISION_HOST,
   * AUTO_DEV_DECISION_PORT) at exec time by the agent dispatcher — no bind mount needed.
   */
  start(worktreePath: string): {
    containerId: string;
    remoteWorkspaceFolder: string;
  } {
    // Default: devcontainer mounts workspace at /workspaces/<basename>
    const defaultRemoteFolder = `/workspaces/${basename(worktreePath)}`;

    // Also mount the main repo's .git directory at the same absolute host path so
    // the worktree's `.git` file pointer (gitdir: <workspaceRoot>/.git/worktrees/…)
    // resolves correctly inside the container.
    const mainGitDir = `${this.workspaceRoot}/.git`;
    const gitMountArg = `type=bind,source=${mainGitDir},target=${mainGitDir}`;

    let output: string;
    try {
      output = execFileSync(
        "devcontainer",
        [
          "up",
          "--workspace-folder",
          worktreePath,
          "--mount",
          gitMountArg,
        ],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    } catch (err) {
      logger.warn(
        `[auto-dev] Devcontainer up failed for ${worktreePath}, trying direct docker run fallback: ${String(err)}`,
      );
      return this.startFallbackContainer(
        worktreePath,
        defaultRemoteFolder,
      );
    }

    // Parse JSON output to extract containerId and remoteWorkspaceFolder
    // devcontainer up outputs JSON lines; look for the containerId field
    const lines = output.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.containerId && typeof parsed.containerId === "string") {
          const remoteWorkspaceFolder =
            typeof parsed.remoteWorkspaceFolder === "string"
              ? parsed.remoteWorkspaceFolder
              : defaultRemoteFolder;
          return { containerId: parsed.containerId, remoteWorkspaceFolder };
        }
      } catch {
        // Not a JSON line, skip
        continue;
      }
    }

    // Fallback: try docker ps to find the most recent container for this worktree
    const dockerOutput = execFileSync(
      "docker",
      ["ps", "--latest", "--format", "{{.ID}}"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();

    if (dockerOutput) {
      return {
        containerId: dockerOutput,
        remoteWorkspaceFolder: defaultRemoteFolder,
      };
    }

    throw new Error(
      `Could not determine container ID from devcontainer up output:\n${output}`,
    );
  }

  /**
   * Fallback: when devcontainer CLI fails (e.g. network unavailable for feature pull),
   * start a plain Docker container using the autodev image which already has
   * all required tooling (claude, auto-dev, git, pnpm, etc).
   *
   * The workspace is mounted at /workspaces/<basename> to match devcontainer convention.
   * `--add-host=host.docker.internal:host-gateway` ensures the container can reach the
   * orchestrator's TCP decision server on the host network.
   */
  private startFallbackContainer(
    worktreePath: string,
    remoteWorkspaceFolder: string,
  ): { containerId: string; remoteWorkspaceFolder: string } {
    const worktreeName = basename(worktreePath);
    const containerName = `autodev-worktree-${worktreeName}`;

    // Stop and remove any existing container with the same name
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
    } catch {
      /* ignore if not found */
    }

    // Choose image: prefer existing devcontainer image if available, else autodev:latest
    // Look for any vsc-autodev-* image (built from the same Dockerfile)
    let imageToUse = "autodev:latest";
    try {
      const images = execFileSync(
        "docker",
        [
          "images",
          "--format",
          "{{.Repository}}:{{.Tag}}",
          "--filter",
          "reference=vsc-autodev-*",
        ],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      const firstImage = images.split("\n").find((l) => l.trim());
      if (firstImage) imageToUse = firstImage.trim();
    } catch {
      /* use default */
    }

    logger.info(
      `[auto-dev] Starting fallback container for ${worktreePath} using image ${imageToUse}`,
    );

    // Run detached container with worktree mount, keeping it alive.
    // --add-host=host.docker.internal:host-gateway allows the container to reach
    // the orchestrator's TCP decision server running on the host (Linux Docker).
    // Also mount the main repo's .git directory at the same absolute host path so
    // that the worktree's `.git` file pointer (gitdir: <workspaceRoot>/.git/worktrees/…)
    // resolves correctly inside the container.
    const mainGitDir = `${this.workspaceRoot}/.git`;
    const containerId = execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        containerName,
        "--add-host=host.docker.internal:host-gateway",
        "--mount",
        `type=bind,source=${worktreePath},target=${remoteWorkspaceFolder}`,
        "--mount",
        `type=bind,source=${mainGitDir},target=${mainGitDir}`,
        "-w",
        remoteWorkspaceFolder,
        imageToUse,
        "sleep",
        "infinity",
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();

    logger.info(`[auto-dev] Fallback container started: ${containerId}`);
    return { containerId, remoteWorkspaceFolder };
  }

  /**
   * Execute a command inside the running container.
   * Returns the exit code.
   */
  exec(
    containerId: string,
    command: string[],
    env: Record<string, string>,
  ): number {
    const envArgs = Object.entries(env).flatMap(([k, v]) => [
      "-e",
      `${k}=${v}`,
    ]);
    try {
      execFileSync("docker", ["exec", ...envArgs, containerId, ...command], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return 0;
    } catch (err) {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const exitCode = (err as { status?: number }).status ?? 1;
      return exitCode;
    }
  }

  /**
   * Stop and remove a container.
   */
  stop(containerId: string): void {
    try {
      execSync(`docker stop --time=30 ${containerId}`, { stdio: "ignore" });
    } catch {
      // Timeout or already stopped; force kill
      try {
        execSync(`docker kill ${containerId}`, { stdio: "ignore" });
      } catch {
        /* best-effort */
      }
    }
    try {
      execSync(`docker rm --force ${containerId}`, { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  }

  /**
   * Check if a container is running.
   */
  isRunning(containerId: string): boolean {
    try {
      const status = execFileSync(
        "docker",
        ["inspect", containerId, "--format", "{{.State.Status}}"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      return status === "running";
    } catch {
      return false;
    }
  }
}
