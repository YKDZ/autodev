import { randomUUID } from "node:crypto";
import { mkdtempSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type {
  WorkflowRun,
  DecisionBlock,
  WorkspaceRegistryEntry,
} from "@/shared/types.js";

import {
  ensureStateDirs,
  saveWorkflowRun,
  loadWorkflowRun,
  listWorkflowRuns,
  saveDecision,
  loadDecision,
  listDecisions,
  saveCoordinatorState,
  loadCoordinatorState,
  registerWorkspace,
  unregisterWorkspace,
  findWorkspaceByIssueNumber,
  listAllWorkspaces,
  closeDb,
} from "./state-store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(resolve(tmpdir(), "auto-dev-test-"));
  await ensureStateDirs(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  closeDb();
});

const makeRun = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: randomUUID(),
  issueNumber: 1,
  repoFullName: "owner/repo",
  status: "pending",
  branch: "auto-dev/issue-1",
  agentModel: null,
  agentEffort: null,
  agentDefinition: null,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  decisionCount: 0,
  pendingDecisionIds: [],
  prNumber: null,
  ...overrides,
});

const makeDecision = (
  overrides: Partial<DecisionBlock> = {},
): DecisionBlock => ({
  id: randomUUID(),
  workflowRunId: randomUUID(),
  title: "Test decision",
  options: [{ key: "a", label: "Option A", description: "First option" }],
  recommendation: "a",
  context: null,
  alias: "d1",
  status: "pending",
  resolution: null,
  resolvedBy: null,
  resolutionChannel: null,
  requestedAt: new Date().toISOString(),
  resolvedAt: null,
  batchId: null,
  socketConnectionId: null,
  ...overrides,
});

describe("ensureStateDirs", () => {
  it("creates state directory and SQLite database", async () => {
    expect(existsSync(resolve(tmpDir, "tools/auto-dev/state"))).toBe(true);
    expect(existsSync(resolve(tmpDir, "tools/auto-dev/state/autodev.db"))).toBe(
      true,
    );
  });
});

describe("WorkflowRun CRUD", () => {
  it("save + load round-trips correctly", async () => {
    const run = makeRun();
    await saveWorkflowRun(tmpDir, run);
    const loaded = loadWorkflowRun(tmpDir, run.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(run.id);
    expect(loaded!.issueNumber).toBe(run.issueNumber);
    expect(loaded!.status).toBe("pending");
  });

  it("loadWorkflowRun returns null for missing id", () => {
    const loaded = loadWorkflowRun(tmpDir, "nonexistent-id");
    expect(loaded).toBeNull();
  });

  it("listWorkflowRuns returns all saved runs", async () => {
    await saveWorkflowRun(tmpDir, makeRun());
    await saveWorkflowRun(tmpDir, makeRun());
    await saveWorkflowRun(tmpDir, makeRun());
    const list = listWorkflowRuns(tmpDir);
    expect(list).toHaveLength(3);
  });

  it("listWorkflowRuns returns empty array when db has no runs", () => {
    const list = listWorkflowRuns(tmpDir);
    expect(list).toEqual([]);
  });
});

describe("DecisionBlock CRUD", () => {
  it("save + load round-trips correctly", async () => {
    const decision = makeDecision();
    await saveDecision(tmpDir, decision);
    const loaded = loadDecision(tmpDir, decision.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(decision.id);
    expect(loaded!.status).toBe("pending");
  });

  it("pending decision persists correctly", async () => {
    const decision = makeDecision({ status: "pending", resolution: null });
    await saveDecision(tmpDir, decision);
    const loaded = loadDecision(tmpDir, decision.id);
    expect(loaded!.status).toBe("pending");
    expect(loaded!.resolution).toBeNull();
  });

  it("resolved decision persists correctly", async () => {
    const decision = makeDecision({
      status: "resolved",
      resolution: "a",
      resolvedBy: "human",
      resolvedAt: new Date().toISOString(),
    });
    await saveDecision(tmpDir, decision);
    const loaded = loadDecision(tmpDir, decision.id);
    expect(loaded!.status).toBe("resolved");
    expect(loaded!.resolution).toBe("a");
  });

  it("loadDecision returns null for missing file", () => {
    const loaded = loadDecision(tmpDir, "nonexistent-id");
    expect(loaded).toBeNull();
  });

  it("listDecisions returns all decisions", async () => {
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await saveDecision(tmpDir, makeDecision());
    }
    const list = listDecisions(tmpDir);
    expect(list).toHaveLength(5);
  });
});

describe("CoordinatorState", () => {
  it("save + load round-trips correctly", async () => {
    const state = {
      startedAt: new Date().toISOString(),
      pollIntervalSec: 30,
      activeRunIds: ["run-1", "run-2"],
    };
    await saveCoordinatorState(tmpDir, state);
    const loaded = loadCoordinatorState(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.startedAt).toBe(state.startedAt);
    expect(loaded!.pollIntervalSec).toBe(30);
    expect(loaded!.activeRunIds).toEqual(["run-1", "run-2"]);
  });

  it("returns null when file missing", () => {
    const loaded = loadCoordinatorState(tmpDir);
    expect(loaded).toBeNull();
  });
});

describe("Workspace Registry CRUD", () => {
  const makeEntry = (issueNumber: number): WorkspaceRegistryEntry => ({
    issueNumber,
    runId: randomUUID(),
    worktreePath: `/tmp/worktree-${issueNumber}`,
    containerId: "container-abc123",
    branch: `auto-dev/issue-${issueNumber}`,
    createdAt: new Date().toISOString(),
  });

  it("register + find round-trips correctly", async () => {
    const entry = makeEntry(42);
    await registerWorkspace(tmpDir, entry);
    const found = findWorkspaceByIssueNumber(tmpDir, 42);
    expect(found).not.toBeNull();
    expect(found!.issueNumber).toBe(42);
    expect(found!.runId).toBe(entry.runId);
    expect(found!.worktreePath).toBe(entry.worktreePath);
  });

  it("unregister removes entry", async () => {
    const entry = makeEntry(99);
    await registerWorkspace(tmpDir, entry);
    await unregisterWorkspace(tmpDir, 99);
    const found = findWorkspaceByIssueNumber(tmpDir, 99);
    expect(found).toBeNull();
  });

  it("findWorkspaceByIssueNumber returns null for non-existent", () => {
    const found = findWorkspaceByIssueNumber(tmpDir, 999);
    expect(found).toBeNull();
  });

  it("listAllWorkspaces returns all registered entries", async () => {
    await registerWorkspace(tmpDir, makeEntry(1));
    await registerWorkspace(tmpDir, makeEntry(2));
    await registerWorkspace(tmpDir, makeEntry(3));
    const all = listAllWorkspaces(tmpDir);
    expect(all).toHaveLength(3);
  });
});

describe("SQLite schema", () => {
  it("creates all three tables", () => {
    const dbPath = resolve(tmpDir, "tools/auto-dev/state/autodev.db");
    const db = new DatabaseSync(dbPath);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Record<string, unknown>[];
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const tableNames = tables.map((t) => t.name as string);
    expect(tableNames).toContain("workflow_runs");
    expect(tableNames).toContain("decision_blocks");
    expect(tableNames).toContain("workspace_registry");
    db.close();
  });
});
