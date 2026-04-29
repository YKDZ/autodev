/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- devcontainer CLI JSON and Docker error objects */
import { execFileSync, execSync } from "node:child_process";

export class DevcontainerManager {
  constructor(_workspaceRoot: string) {
    /* workspaceRoot kept for future use */
  }

  /**
   * Start a devcontainer for the given worktree path.
   * Returns the container ID.
   */
  start(worktreePath: string): string {
    const output = execFileSync(
      "devcontainer",
      ["up", "--workspace-folder", worktreePath],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();

    // Parse JSON output to extract container ID
    // devcontainer up outputs JSON lines; look for the containerId field
    const lines = output.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.containerId && typeof parsed.containerId === "string") {
          return parsed.containerId;
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
      // Tag the container with autodev labels
      try {
        execSync(
          `docker label ${dockerOutput} autodev-worktree="${worktreePath}" autodev-run-id="unknown"`,
          { stdio: "ignore" },
        );
      } catch {
        /* best-effort */
      }
      return dockerOutput;
    }

    throw new Error(
      `Could not determine container ID from devcontainer up output:\n${output}`,
    );
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
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    try {
      execFileSync(
        "docker",
        ["exec", ...envArgs, containerId, ...command],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
