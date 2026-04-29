import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentInvoker, AgentContext, AgentEvent } from "../protocol.js";

import { getAuthEnv } from "../../shared/github-app-auth.js";

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
    const { parseFrontmatter: parseFm, stripFrontmatter } =
      await import("../../shared/frontmatter-parser.js");
    const agentFm = parseFm(rawContent);
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
      CLAUDE_CODE_TOOL_TIMEOUT_MS: "86400000",
      MOON_WORKSPACE_ROOT: context.workspaceRoot,
    };

    const cwd = context.agentWorkdir ?? context.workspaceRoot;

    if (context.containerId) {
      // Run inside a dev container via docker exec
      const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const dockerArgs = [
        "exec",
        "-w", cwd,
        ...envArgs,
        context.containerId,
        "claude",
        ...args,
      ];

      // Execute synchronously and capture output
      // For streaming, we'd need a more sophisticated approach, but for now
      // execFileSync is simpler and the streaming is less critical in the new architecture
      try {
        const output = execFileSync("docker", dockerArgs, {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        yield { type: "stdout", data: output };
        yield { type: "exit", exitCode: 0 };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: "stderr", data: message };
        yield { type: "exit", exitCode: 1 };
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
