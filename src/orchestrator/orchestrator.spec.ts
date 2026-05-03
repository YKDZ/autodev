import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { WorkflowRun } from "@/shared/types.js";

vi.mock("@/shared/gh-cli.js", () => ({
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

vi.mock("../workspace-manager/index.js", () => ({
  WorkspaceManager: class {
    getGitManager() {
      return {
        // oxlint-disable-next-line no-empty-function
        ensureRepo: async () => undefined,
        // oxlint-disable-next-line no-empty-function
        commitAndPush: async () => undefined,
        tryPush: async () => true,
      };
    }

    async create() {
      return {
        branch: "auto-dev/issue-1",
        worktreePath: "/tmp/worktree",
        containerId: "",
        remoteWorkspaceFolder: "",
      };
    }

    async createFromBase() {
      return {
        branch: "auto-dev/issue-1",
        worktreePath: "/tmp/worktree",
        containerId: "",
        remoteWorkspaceFolder: "",
      };
    }

    async ensure() {
      return {
        branch: "auto-dev/issue-1",
        worktreePath: "/tmp/worktree",
        containerId: "",
        remoteWorkspaceFolder: "",
      };
    }

    // oxlint-disable-next-line no-empty-function
    async destroy() {
      return undefined;
    }
  },
}));

import { ensureStateDirs } from "@/state-store/index.js";

import { Orchestrator } from "./orchestrator.js";

let tmpDir: string;
let oldDecisionPort: string | undefined;

beforeEach(async () => {
  tmpDir = mkdtempSync(resolve(tmpdir(), "coord-test-"));
  oldDecisionPort = process.env.AUTO_DEV_DECISION_PORT;
  // Use a random high port for tests to avoid conflicts
  process.env.AUTO_DEV_DECISION_PORT = String(
    30000 + Math.floor(Math.random() * 10000),
  );
  process.env.AUTO_DEV_DECISION_HOST = "127.0.0.1";
  // Use insecure-local mode in tests so no real webhook secret is required
  process.env.AUTO_DEV_WEBHOOK_FORWARD_INSECURE_LOCAL = "1";
  await ensureStateDirs(tmpDir);
});

afterEach(async () => {
  if (oldDecisionPort) {
    process.env.AUTO_DEV_DECISION_PORT = oldDecisionPort;
  } else {
    delete process.env.AUTO_DEV_DECISION_PORT;
  }
  delete process.env.AUTO_DEV_DECISION_HOST;
  delete process.env.AUTO_DEV_WEBHOOK_FORWARD_INSECURE_LOCAL;
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

  it("buildCreatePRIssueContext includes issue body and labels", () => {
    const orchestrator = new Orchestrator(tmpDir, "owner/repo");
    // Seed config accessed by the helper through this.config
    orchestrator["config"] = {
      defaultAgent: "full-pipeline",
      pollIntervalSec: 30,
      maxDecisionPerRun: 20,
      maxImplCycles: 5,
      maxConcurrentRuns: 3,
      agents: {},
    };

    const run: WorkflowRun = {
      id: "run-1",
      issueNumber: 42,
      issueTitle: "Fix parser",
      issueBody: "Please keep backward compatibility.",
      issueLabels: ["auto-dev:ready", "bug"],
      issueAuthor: "octocat",
      repoFullName: "owner/repo",
      status: "running",
      branch: "auto-dev/issue-42",
      agentModel: "sonnet",
      agentEffort: "high",
      agentDefinition: "full-pipeline",
      maxTurns: 12,
      maxDecisions: 4,
      permissionMode: "plan",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      decisionCount: 0,
      pendingDecisionIds: [],
      prNumber: 100,
      lastPushedSha: null,
      lastObservedRemoteSha: null,
    };

    const content = orchestrator["buildCreatePRIssueContext"](
      run,
      100,
      "full-pipeline",
    );

    expect(content).toContain("Please keep backward compatibility.");
    expect(content).toContain("- auto-dev:ready");
    expect(content).toContain("- bug");
  });
});
