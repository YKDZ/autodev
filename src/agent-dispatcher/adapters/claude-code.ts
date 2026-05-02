import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseFrontmatter,
  stripFrontmatter,
} from "@/shared/frontmatter-parser.js";
import { getAuthEnv } from "@/shared/github-app-auth.js";

import type { AgentInvoker, AgentContext, AgentEvent } from "../protocol.js";

const forwardHostEnv = (): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (key.startsWith("ANTHROPIC_")) {
      result[key] = value;
    }
  }
  return result;
};

export class ClaudeCodeAdapter implements AgentInvoker {
  async *invoke(context: AgentContext): AsyncIterable<AgentEvent> {
    const agentsDir = process.env["AUTO_DEV_AGENTS_DIR"]
      ? resolve(context.workspaceRoot, process.env["AUTO_DEV_AGENTS_DIR"])
      : resolve(context.workspaceRoot, ".claude/agents");
    const defFile =
      context.agentDefinitionFile ?? `${context.agentDefinition}.md`;
    const defPath = resolve(agentsDir, defFile);
    const rawContent = existsSync(defPath)
      ? readFileSync(defPath, "utf-8")
      : "";
    const agentFm = parseFrontmatter(rawContent);
    const defContent = stripFrontmatter(rawContent);

    // Agent definition frontmatter provides defaults (lowest priority)
    const model = context.model ?? agentFm?.model ?? null;
    const effort = context.effort ?? agentFm?.effort ?? null;

    const prompt = `${defContent}\n\n## Issue Context\n\n${context.issueContext}`;

    const args: string[] = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      "Bash,Read,Write,Edit,Glob,Grep",
      "--max-turns",
      "200",
    ];

    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);

    const env: Record<string, string> = {
      ...(() => {
        try {
          return getAuthEnv();
        } catch {
          return {};
        }
      })(),
      ...forwardHostEnv(),
      CLAUDE_CODE_TOOL_TIMEOUT_MS: "86400000",
      MOON_WORKSPACE_ROOT: context.workspaceRoot,
      // Provide git identity via env so agents can commit without running
      // `git config` or `git init`. These are the standard git env vars.
      GIT_AUTHOR_NAME: "Auto-Dev Agent",
      GIT_AUTHOR_EMAIL: "auto-dev[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Auto-Dev Agent",
      GIT_COMMITTER_EMAIL: "auto-dev[bot]@users.noreply.github.com",
      // When running in a devcontainer, inject the TCP decision server address
      // so agents can call `auto-dev request-decision` via TCP instead of Unix socket.
      // Also expose the auto-dev CLI on PATH so agents can call it.
      ...(context.containerId
        ? {
            AUTO_DEV_DECISION_HOST:
              context.decisionHost ?? "host.docker.internal",
            AUTO_DEV_DECISION_PORT: String(context.decisionPort ?? 3000),
            PATH: "/var/run/auto-dev:/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          }
        : {}),
      // Pass the workflow run ID so agents can call `auto-dev request-decision`.
      ...(context.workflowRunId
        ? { AUTO_DEV_RUN_ID: context.workflowRunId }
        : {}),
    };

    const cwd = context.agentWorkdir ?? context.workspaceRoot;

    if (context.containerId) {
      // Pre-configure git in the devcontainer so agents can commit without
      // needing to run `git config` or `git init`.
      const { execFileSync: execSync } = await import("node:child_process");
      try {
        execSync(
          "docker",
          [
            "exec",
            context.containerId,
            "git",
            "config",
            "--global",
            "user.email",
            "auto-dev[bot]@users.noreply.github.com",
          ],
          { stdio: "ignore" },
        );
        execSync(
          "docker",
          [
            "exec",
            context.containerId,
            "git",
            "config",
            "--global",
            "user.name",
            "Auto-Dev Agent",
          ],
          { stdio: "ignore" },
        );
      } catch {
        // Best-effort; git identity env vars will serve as fallback.
      }

      // Run inside a dev container via docker exec.
      // IMPORTANT: use async spawn (not execFileSync) so the Node.js event loop
      // keeps running while the agent is executing. This is required for the
      // decision socket server to process requests from the agent concurrently.
      const { spawn } = await import("node:child_process");
      const envArgs = Object.entries(env).flatMap(([k, v]) => [
        "-e",
        `${k}=${v}`,
      ]);
      const dockerArgs = [
        "exec",
        "-w",
        cwd,
        ...envArgs,
        context.containerId,
        "claude",
        ...args,
      ];

      const proc = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const queue: AgentEvent[] = [];
      let processExited = false;
      let wakeup: (() => void) | null = null;

      const push = (event: AgentEvent) => {
        queue.push(event);
        wakeup?.();
        wakeup = null;
      };

      proc.stdout?.on("data", (data: Buffer) => {
        push({ type: "stdout", data: data.toString() });
      });

      proc.stderr?.on("data", (data: Buffer) => {
        push({ type: "stderr", data: data.toString() });
      });

      proc.on("close", (code: number | null) => {
        push({ type: "exit", exitCode: code ?? 0 });
        processExited = true;
      });

      while (true) {
        if (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
          if (event.type === "exit") break;
        } else if (processExited) {
          break;
        } else {
          // oxlint-disable-next-line no-await-in-loop
          await new Promise<void>((resolve) => {
            wakeup = resolve;
          });
        }
      }
    } else {
      // Fallback: spawn locally (backward compat for tests)
      const { spawn } = await import("node:child_process");
      const proc = spawn("claude", args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const queue: AgentEvent[] = [];
      let processExited = false;
      let wakeup: (() => void) | null = null;

      const push = (event: AgentEvent) => {
        queue.push(event);
        wakeup?.();
        wakeup = null;
      };

      proc.stdout?.on("data", (data: Buffer) => {
        push({ type: "stdout", data: data.toString() });
      });

      proc.stderr?.on("data", (data: Buffer) => {
        push({ type: "stderr", data: data.toString() });
      });

      proc.on("close", (code: number | null) => {
        push({ type: "exit", exitCode: code ?? 0 });
        processExited = true;
      });

      while (true) {
        if (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
          if (event.type === "exit") break;
        } else if (processExited) {
          break;
        } else {
          // oxlint-disable-next-line no-await-in-loop
          await new Promise<void>((resolve) => {
            wakeup = resolve;
          });
        }
      }
    }
  }
}
