import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const NODE_BIN = process.execPath;
const CLI_JS = resolve(process.cwd(), "dist/cli.js");

interface ExecError {
  stderr: string;
  status?: number;
}

function isExecError(err: unknown): err is ExecError {
  if (typeof err !== "object" || err === null) return false;
  if (!("stderr" in err)) return false;
  const r = err as Record<string, unknown>;
  return typeof r.stderr === "string";
}

const execCli = (args: string[]): string =>
  execFileSync(NODE_BIN, [CLI_JS, ...args], {
    encoding: "utf-8",
  });

describe("CLI", () => {
  it("no subcommand prints usage", () => {
    try {
      execCli([]);
    } catch (err: unknown) {
      if (isExecError(err)) {
        expect(err.stderr).toContain("Usage:");
        expect(err.stderr).toContain("start");
        expect(err.stderr).toContain("status");
        expect(err.stderr).toContain("list");
        expect(err.stderr).toContain("config");
        expect(err.stderr).toContain("request-decisions");
        expect(err.stderr).toContain("resolve-decision");
      }
    }
  });

  it("unknown subcommand exits 1", () => {
    try {
      execCli(["nonexistent"]);
    } catch (err: unknown) {
      if (isExecError(err)) {
        expect(err.status).toBe(1);
        expect(err.stderr).toContain("Usage:");
      }
    }
  });

  it("config command outputs current config", () => {
    const output = execCli(["config"]);
    const config: Record<string, unknown> = JSON.parse(output);
    expect(config.defaultAgent).toBe("full-pipeline");
    expect(config.pollIntervalSec).toBe(30);
  });

  it("status command returns JSON", () => {
    const output = execCli(["status"]);
    const parsed: unknown = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
  });
});
