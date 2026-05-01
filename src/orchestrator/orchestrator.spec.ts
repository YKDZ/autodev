import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../shared/gh-cli.js", () => ({
  listIssues: vi.fn().mockReturnValue([]),
}));

vi.mock("../config/loader.js", () => ({
  loadConfig: vi.fn().mockResolvedValue({
    agents: {},
    defaultAgent: "full-pipeline",
    pollIntervalSec: 3600,
    maxDecisionPerRun: 20,
    maxImplCycles: 5,
  }),
}));

import { ensureStateDirs } from "../state-store/index.js";
import { Orchestrator } from "./orchestrator.js";

let tmpDir: string;
let oldSocketPath: string | undefined;

beforeEach(async () => {
  tmpDir = mkdtempSync(resolve(tmpdir(), "coord-test-"));
  oldSocketPath = process.env.AUTO_DEV_SOCKET;
  process.env.AUTO_DEV_SOCKET = resolve(tmpDir, "test.sock");
  await ensureStateDirs(tmpDir);
});

afterEach(async () => {
  if (oldSocketPath) {
    process.env.AUTO_DEV_SOCKET = oldSocketPath;
  } else {
    delete process.env.AUTO_DEV_SOCKET;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Orchestrator", () => {
  it("can be instantiated", () => {
    const orchestrator = new Orchestrator(tmpDir, "owner/repo");
    expect(orchestrator).toBeInstanceOf(Orchestrator);
  });

  it("start initializes and sets polling", async () => {
    const orchestrator = new Orchestrator(tmpDir, "owner/repo");
    const startPromise = orchestrator.start();
    await new Promise((r) => setTimeout(r, 100));
    await orchestrator.stop();
    await expect(startPromise).resolves.toBeUndefined();
  }, 10000);

  it("stop can be called without start", async () => {
    const orchestrator = new Orchestrator(tmpDir, "owner/repo");
    await expect(orchestrator.stop()).resolves.toBeUndefined();
  });

  it("stop cleans up prTriggerPollTimer without errors", async () => {
    const orchestrator = new Orchestrator(tmpDir, "owner/repo");
    const startPromise = orchestrator.start();
    await new Promise((r) => setTimeout(r, 50));
    await expect(orchestrator.stop()).resolves.toBeUndefined();
    await startPromise.catch((_err: unknown) => {
      // swallow expected setup errors during stop() test
      void _err;
    });
  }, 10000);

  it("collectResolutionTasks filters bot comments", () => {
    const orchestrator = new Orchestrator(tmpDir, "owner/repo");
    const fn = orchestrator["collectResolutionTasks"].bind(orchestrator);
    const botComment = {
      id: "bot-1",
      body: "<!-- auto-dev-bot -->\n@d1 yes",
      user: { login: "auto-dev[bot]" },
    };
    const result = fn([botComment], "some-run-id");
    expect(result).toHaveLength(0);
  });
});
