/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- SQLite returns Record<string, unknown> */

import {
  cpSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import z from "zod";

import type {
  WorkflowRun,
  DecisionBlock,
  WorkspaceRegistryEntry,
} from "@/shared/types.js";

import { WorkflowRunSchema, DecisionBlockSchema } from "@/shared/schemas.js";

const MIGRATION_MARKER_FILE = ".migrated-to-sqlite";

const _dbs = new Map<string, DatabaseSync>();

const getDbPath = (workspaceRoot: string): string =>
  `${workspaceRoot}/tools/auto-dev/state/autodev.db`;

const getDb = (workspaceRoot: string): DatabaseSync => {
  const cached = _dbs.get(workspaceRoot);
  if (cached) return cached;
  const dbPath = getDbPath(workspaceRoot);
  const stateDir = `${workspaceRoot}/tools/auto-dev/state`;
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath, { enableWAL: true });
  initSchema(db);
  _dbs.set(workspaceRoot, db);
  return db;
};

const hasMigration = (db: DatabaseSync, version: number): boolean => {
  const row = db
    .prepare("SELECT 1 AS ok FROM schema_migrations WHERE version = ? LIMIT 1")
    .get(version) as { ok?: number } | undefined;
  return row?.ok === 1;
};

const recordMigration = (db: DatabaseSync, version: number): void => {
  db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(version, new Date().toISOString());
};

const withDbTx = (db: DatabaseSync, fn: () => void): void => {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* best-effort */
    }
    throw err;
  }
};

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === column);
};

const ensureColumn = (
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void => {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

const initSchema = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  if (!hasMigration(db, 1)) {
    withDbTx(db, () => {
      db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      issue_number INTEGER NOT NULL,
      issue_title TEXT NOT NULL DEFAULT '',
      issue_body TEXT NOT NULL DEFAULT '',
      issue_labels TEXT NOT NULL DEFAULT '[]',
      issue_author TEXT,
      repo_full_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      branch TEXT NOT NULL,
      agent_definition TEXT NOT NULL DEFAULT '',
      agent_model TEXT,
      agent_effort TEXT,
      max_turns INTEGER,
      max_decisions INTEGER,
      permission_mode TEXT,
      base_branch TEXT NOT NULL DEFAULT 'main',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decision_count INTEGER NOT NULL DEFAULT 0,
      pending_decision_ids TEXT NOT NULL DEFAULT '[]',
      pr_number INTEGER,
      last_pushed_sha TEXT,
      last_observed_remote_sha TEXT
    )
  `);

      db.exec(`
    CREATE TABLE IF NOT EXISTS decision_blocks (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      title TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '[]',
      recommendation TEXT NOT NULL DEFAULT '',
      context TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      choice TEXT,
      resolved_by TEXT,
      resolution_channel TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      batch_id TEXT,
      socket_connection_id TEXT
    )
  `);

      db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_registry (
      issue_number INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      container_id TEXT NOT NULL,
      remote_workspace_folder TEXT NOT NULL DEFAULT '',
      container_source TEXT NOT NULL DEFAULT 'devcontainer',
      image TEXT,
      branch TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS processed_events (
          handler TEXT NOT NULL,
          github_comment_id TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          issue_or_pr_number INTEGER NOT NULL,
          processed_at TEXT NOT NULL,
          PRIMARY KEY (handler, github_comment_id)
        )
      `);

      recordMigration(db, 1);
    });
  }

  if (!hasMigration(db, 2)) {
    withDbTx(db, () => {
      ensureColumn(db, "workflow_runs", "issue_title", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "workflow_runs", "issue_body", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(
        db,
        "workflow_runs",
        "issue_labels",
        "TEXT NOT NULL DEFAULT '[]'",
      );
      ensureColumn(db, "workflow_runs", "issue_author", "TEXT");
      ensureColumn(db, "workflow_runs", "max_turns", "INTEGER");
      ensureColumn(db, "workflow_runs", "max_decisions", "INTEGER");
      ensureColumn(db, "workflow_runs", "permission_mode", "TEXT");
      ensureColumn(
        db,
        "workflow_runs",
        "base_branch",
        "TEXT NOT NULL DEFAULT 'main'",
      );
      ensureColumn(db, "workflow_runs", "last_pushed_sha", "TEXT");
      ensureColumn(db, "workflow_runs", "last_observed_remote_sha", "TEXT");

      ensureColumn(
        db,
        "workspace_registry",
        "remote_workspace_folder",
        "TEXT NOT NULL DEFAULT ''",
      );
      ensureColumn(
        db,
        "workspace_registry",
        "container_source",
        "TEXT NOT NULL DEFAULT 'devcontainer'",
      );
      ensureColumn(db, "workspace_registry", "image", "TEXT");

      db.exec(`
        CREATE TABLE IF NOT EXISTS processed_events (
          handler TEXT NOT NULL,
          github_comment_id TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          issue_or_pr_number INTEGER NOT NULL,
          processed_at TEXT NOT NULL,
          PRIMARY KEY (handler, github_comment_id)
        )
      `);

      recordMigration(db, 2);
    });
  }

  if (!hasMigration(db, 3)) {
    withDbTx(db, () => {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_workflow_runs_issue_status ON workflow_runs(issue_number, status)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_workflow_runs_pr_number ON workflow_runs(pr_number)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_decision_blocks_run_status ON decision_blocks(workflow_run_id, status)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_workspace_registry_run_id ON workspace_registry(run_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_processed_events_processed_at ON processed_events(processed_at)",
      );

      recordMigration(db, 3);
    });
  }
};

export const closeDb = (): void => {
  for (const db of _dbs.values()) {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  }
  _dbs.clear();
};

// ── Migration from JSON files ─────────────────────────────────────────

const getMigrationMarkerPath = (workspaceRoot: string): string =>
  `${workspaceRoot}/tools/auto-dev/state/${MIGRATION_MARKER_FILE}`;

const getRunsDir = (workspaceRoot: string): string =>
  `${workspaceRoot}/tools/auto-dev/state/runs`;

const getDecisionsDir = (workspaceRoot: string): string =>
  `${workspaceRoot}/tools/auto-dev/state/decisions`;

export const migrateFromJson = (workspaceRoot: string): void => {
  const markerPath = getMigrationMarkerPath(workspaceRoot);
  if (existsSync(markerPath)) return; // Already migrated

  const db = getDb(workspaceRoot);

  // Migrate workflow runs
  const runsDir = getRunsDir(workspaceRoot);
  if (existsSync(runsDir)) {
    const files = readdirSync(runsDir).filter((f: string) =>
      f.endsWith(".json"),
    );
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO workflow_runs
        (id, issue_number, issue_title, issue_body, issue_labels, issue_author,
         repo_full_name, status, branch, agent_definition, agent_model,
         agent_effort, max_turns, max_decisions, permission_mode, base_branch,
         started_at, updated_at, decision_count, pending_decision_ids, pr_number,
         last_pushed_sha, last_observed_remote_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const file of files) {
      try {
        const raw = readFileSync(`${runsDir}/${file}`, "utf-8");
        const run = WorkflowRunSchema.parse(JSON.parse(raw)) as WorkflowRun;
        stmt.run(
          run.id,
          run.issueNumber,
          run.issueTitle,
          run.issueBody,
          JSON.stringify(run.issueLabels),
          run.issueAuthor,
          run.repoFullName,
          run.status,
          run.branch,
          run.agentDefinition ?? "",
          run.agentModel,
          run.agentEffort,
          run.maxTurns,
          run.maxDecisions,
          run.permissionMode,
          run.baseBranch,
          run.startedAt,
          run.updatedAt,
          run.decisionCount,
          JSON.stringify(run.pendingDecisionIds),
          run.prNumber,
          run.lastPushedSha,
          run.lastObservedRemoteSha,
        );
      } catch {
        // Skip corrupted files
      }
    }
  }

  // Migrate decision blocks
  const decisionsDir = getDecisionsDir(workspaceRoot);
  if (existsSync(decisionsDir)) {
    const files = readdirSync(decisionsDir).filter((f: string) =>
      f.endsWith(".json"),
    );
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO decision_blocks
        (id, workflow_run_id, alias, title, options, recommendation, context,
         status, choice, resolved_by, resolution_channel, created_at, resolved_at,
         batch_id, socket_connection_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const file of files) {
      try {
        const raw = readFileSync(`${decisionsDir}/${file}`, "utf-8");
        const decision = DecisionBlockSchema.parse(
          JSON.parse(raw),
        ) as DecisionBlock;
        stmt.run(
          decision.id,
          decision.workflowRunId,
          decision.alias,
          decision.title,
          JSON.stringify(decision.options),
          decision.recommendation,
          decision.context,
          decision.status,
          decision.resolution,
          decision.resolvedBy,
          decision.resolutionChannel,
          decision.requestedAt,
          decision.resolvedAt,
          decision.batchId,
          decision.socketConnectionId,
        );
      } catch {
        // Skip corrupted files
      }
    }
  }

  // Write migration marker
  writeFileSync(markerPath, new Date().toISOString(), "utf-8");
};

// ── WorkflowRun CRUD ──────────────────────────────────────────────────

const rowToRun = (row: Record<string, unknown>): WorkflowRun => ({
  id: row.id as string,
  issueNumber: row.issue_number as number,
  issueTitle: ((row.issue_title as string) ?? "").trim()
    ? (row.issue_title as string)
    : `Issue #${row.issue_number as number}`,
  issueBody: (row.issue_body as string) ?? "",
  issueLabels: (() => {
    const raw = row.issue_labels as string | null;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((label): label is string => typeof label === "string")
        : [];
    } catch {
      return [];
    }
  })(),
  issueAuthor: (row.issue_author as string) ?? null,
  repoFullName: row.repo_full_name as string,
  status: row.status as WorkflowRun["status"],
  branch: row.branch as string,
  agentDefinition: (row.agent_definition as string) || "",
  agentModel: (row.agent_model as string) ?? null,
  agentEffort: (row.agent_effort as WorkflowRun["agentEffort"]) ?? null,
  maxTurns: (row.max_turns as number) ?? null,
  maxDecisions: (row.max_decisions as number) ?? null,
  permissionMode: (row.permission_mode as string) ?? null,
  baseBranch: (row.base_branch as string) || "main",
  startedAt: row.started_at as string,
  updatedAt: row.updated_at as string,
  decisionCount: row.decision_count as number,
  pendingDecisionIds: JSON.parse(
    row.pending_decision_ids as string,
  ) as string[],
  prNumber: (row.pr_number as number) ?? null,
  lastPushedSha: (row.last_pushed_sha as string) ?? null,
  lastObservedRemoteSha: (row.last_observed_remote_sha as string) ?? null,
});

export const saveWorkflowRun = async (
  workspaceRoot: string,
  run: WorkflowRun,
): Promise<void> => {
  const db = getDb(workspaceRoot);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO workflow_runs
      (id, issue_number, issue_title, issue_body, issue_labels, issue_author,
       repo_full_name, status, branch, agent_definition, agent_model,
       agent_effort, max_turns, max_decisions, permission_mode, base_branch,
       started_at, updated_at, decision_count, pending_decision_ids, pr_number,
       last_pushed_sha, last_observed_remote_sha)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    run.id,
    run.issueNumber,
    run.issueTitle,
    run.issueBody,
    JSON.stringify(run.issueLabels),
    run.issueAuthor,
    run.repoFullName,
    run.status,
    run.branch,
    run.agentDefinition ?? "",
    run.agentModel,
    run.agentEffort,
    run.maxTurns,
    run.maxDecisions,
    run.permissionMode,
    run.baseBranch,
    run.startedAt,
    run.updatedAt,
    run.decisionCount,
    JSON.stringify(run.pendingDecisionIds),
    run.prNumber,
    run.lastPushedSha,
    run.lastObservedRemoteSha,
  );
};

export const loadWorkflowRun = (
  workspaceRoot: string,
  runId: string,
): WorkflowRun | null => {
  const db = getDb(workspaceRoot);
  const stmt = db.prepare("SELECT * FROM workflow_runs WHERE id = ?");
  const row = stmt.get(runId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToRun(row);
};

export const listWorkflowRuns = (workspaceRoot: string): WorkflowRun[] => {
  const db = getDb(workspaceRoot);
  const stmt = db.prepare(
    "SELECT * FROM workflow_runs ORDER BY started_at DESC",
  );
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map(rowToRun);
};

// ── DecisionBlock CRUD ────────────────────────────────────────────────

const rowToDecision = (row: Record<string, unknown>): DecisionBlock => ({
  id: row.id as string,
  workflowRunId: row.workflow_run_id as string,
  alias: row.alias as string,
  title: row.title as string,
  options: JSON.parse(row.options as string) as DecisionBlock["options"],
  recommendation: row.recommendation as string,
  context: (row.context as string) ?? null,
  status: row.status as DecisionBlock["status"],
  resolution: (row.choice as string) ?? null,
  resolvedBy: (row.resolved_by as string) ?? null,
  resolutionChannel:
    (row.resolution_channel as DecisionBlock["resolutionChannel"]) ?? null,
  requestedAt: row.created_at as string,
  resolvedAt: (row.resolved_at as string) ?? null,
  batchId: (row.batch_id as string) ?? null,
  socketConnectionId: (row.socket_connection_id as string) ?? null,
});

export const saveDecision = async (
  workspaceRoot: string,
  decision: DecisionBlock,
): Promise<void> => {
  const db = getDb(workspaceRoot);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO decision_blocks
      (id, workflow_run_id, alias, title, options, recommendation, context,
       status, choice, resolved_by, resolution_channel, created_at, resolved_at,
       batch_id, socket_connection_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    decision.id,
    decision.workflowRunId,
    decision.alias,
    decision.title,
    JSON.stringify(decision.options),
    decision.recommendation,
    decision.context,
    decision.status,
    decision.resolution,
    decision.resolvedBy,
    decision.resolutionChannel,
    decision.requestedAt,
    decision.resolvedAt,
    decision.batchId,
    decision.socketConnectionId,
  );
};

export const loadDecision = (
  workspaceRoot: string,
  decisionId: string,
): DecisionBlock | null => {
  const db = getDb(workspaceRoot);
  const stmt = db.prepare("SELECT * FROM decision_blocks WHERE id = ?");
  const row = stmt.get(decisionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToDecision(row);
};

export const listDecisions = (workspaceRoot: string): DecisionBlock[] => {
  const db = getDb(workspaceRoot);
  const stmt = db.prepare(
    "SELECT * FROM decision_blocks ORDER BY created_at ASC",
  );
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map(rowToDecision);
};

// ── Workspace Registry CRUD ───────────────────────────────────────────

export const registerWorkspace = async (
  workspaceRoot: string,
  entry: WorkspaceRegistryEntry,
): Promise<void> => {
  const db = getDb(workspaceRoot);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO workspace_registry
      (issue_number, run_id, worktree_path, container_id, remote_workspace_folder,
       container_source, image, branch, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    entry.issueNumber,
    entry.runId,
    entry.worktreePath,
    entry.containerId,
    entry.remoteWorkspaceFolder,
    entry.containerSource,
    entry.image,
    entry.branch,
    entry.createdAt,
  );
};

export const unregisterWorkspace = async (
  workspaceRoot: string,
  issueNumber: number,
): Promise<void> => {
  const db = getDb(workspaceRoot);
  const stmt = db.prepare(
    "DELETE FROM workspace_registry WHERE issue_number = ?",
  );
  stmt.run(issueNumber);
};

export const findWorkspaceByIssueNumber = (
  workspaceRoot: string,
  issueNumber: number,
): WorkspaceRegistryEntry | null => {
  const db = getDb(workspaceRoot);
  const stmt = db.prepare(
    "SELECT * FROM workspace_registry WHERE issue_number = ?",
  );
  const row = stmt.get(issueNumber) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    issueNumber: row.issue_number as number,
    runId: row.run_id as string,
    worktreePath: row.worktree_path as string,
    containerId: row.container_id as string,
    remoteWorkspaceFolder: (row.remote_workspace_folder as string) ?? "",
    containerSource:
      ((row.container_source as string) ?? "devcontainer") === "fallback"
        ? "fallback"
        : "devcontainer",
    image: (row.image as string) ?? null,
    branch: row.branch as string,
    createdAt: row.created_at as string,
  };
};

export const listAllWorkspaces = (
  workspaceRoot: string,
): WorkspaceRegistryEntry[] => {
  const db = getDb(workspaceRoot);
  const stmt = db.prepare(
    "SELECT * FROM workspace_registry ORDER BY created_at DESC",
  );
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map((row) => ({
    issueNumber: row.issue_number as number,
    runId: row.run_id as string,
    worktreePath: row.worktree_path as string,
    containerId: row.container_id as string,
    remoteWorkspaceFolder: (row.remote_workspace_folder as string) ?? "",
    containerSource:
      ((row.container_source as string) ?? "devcontainer") === "fallback"
        ? "fallback"
        : "devcontainer",
    image: (row.image as string) ?? null,
    branch: row.branch as string,
    createdAt: row.created_at as string,
  }));
};

// ── Processed event cursor helpers ───────────────────────────────────────

export const isEventProcessed = (
  workspaceRoot: string,
  handler: string,
  githubCommentId: string,
): boolean => {
  const db = getDb(workspaceRoot);
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM processed_events WHERE handler = ? AND github_comment_id = ? LIMIT 1",
    )
    .get(handler, githubCommentId) as { ok?: number } | undefined;
  return row?.ok === 1;
};

export const markEventProcessed = async (
  workspaceRoot: string,
  input: {
    handler: string;
    githubCommentId: string;
    repoFullName: string;
    issueOrPrNumber: number;
  },
): Promise<boolean> => {
  const db = getDb(workspaceRoot);
  const result = db
    .prepare(
      `
      INSERT OR IGNORE INTO processed_events
        (handler, github_comment_id, repo_full_name, issue_or_pr_number, processed_at)
      VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run(
      input.handler,
      input.githubCommentId,
      input.repoFullName,
      input.issueOrPrNumber,
      new Date().toISOString(),
    ) as { changes?: number };
  return (result.changes ?? 0) > 0;
};

export const cleanupProcessedEvents = async (
  workspaceRoot: string,
  olderThanDays = 30,
): Promise<number> => {
  const db = getDb(workspaceRoot);
  const cutoff = new Date(
    Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare("DELETE FROM processed_events WHERE processed_at < ?")
    .run(cutoff) as { changes?: number };
  return result.changes ?? 0;
};

// ── Transaction helper ───────────────────────────────────────────────────

export const withTransaction = async <T>(
  workspaceRoot: string,
  fn: (db: DatabaseSync) => Promise<T> | T,
): Promise<T> => {
  const db = getDb(workspaceRoot);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* best-effort */
    }
    throw err;
  }
};

// ── CoordinatorState helpers (kept for backward compat, simplified) ───

export const saveCoordinatorState = async (
  workspaceRoot: string,
  state: { startedAt: string; pollIntervalSec: number; activeRunIds: string[] },
): Promise<void> => {
  const dir = `${workspaceRoot}/tools/auto-dev/state`;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    `${dir}/coordinator.json`,
    JSON.stringify(state, null, 2),
    "utf-8",
  );
};

export const loadCoordinatorState = (
  workspaceRoot: string,
): {
  startedAt: string;
  pollIntervalSec: number;
  activeRunIds: string[];
} | null => {
  const path = `${workspaceRoot}/tools/auto-dev/state/coordinator.json`;
  if (!existsSync(path)) return null;
  try {
    const CoordinatorStateSchema = z.object({
      startedAt: z.string(),
      pollIntervalSec: z.number(),
      activeRunIds: z.array(z.string()),
    });
    return CoordinatorStateSchema.parse(
      JSON.parse(readFileSync(path, "utf-8")),
    );
  } catch {
    return null;
  }
};

// ── Directory initialization (simplified for SQLite) ──────────────────

export const ensureStateDirs = async (workspaceRoot: string): Promise<void> => {
  const stateDir = `${workspaceRoot}/tools/auto-dev/state`;
  mkdirSync(stateDir, { recursive: true });

  // Publish the auto-dev CLI into the state dir so devcontainers can invoke it.
  // The state dir is bind-mounted at /var/run/auto-dev inside devcontainers, so
  // placing the binary and dist/ there makes `auto-dev` available on PATH.
  // Always sync on startup so that upgrades are picked up automatically.
  const sourceDistDir = "/opt/auto-dev/dist";
  if (existsSync(sourceDistDir)) {
    const targetDistDir = `${stateDir}/dist`;
    cpSync(sourceDistDir, targetDistDir, { recursive: true, force: true });
    const autoDevBin = `${stateDir}/auto-dev`;
    writeFileSync(
      autoDevBin,
      '#!/bin/bash\nexec node /var/run/auto-dev/dist/cli.js "$@"\n',
    );
    chmodSync(autoDevBin, 0o755);
  }

  // Run migration on first access
  migrateFromJson(workspaceRoot);
};

// ── Legacy sync exports (kept as no-ops for backward compat) ──────────

export const saveSyncMappings = async (): Promise<void> => {
  // No-op: doc-sync removed
};

export const loadSyncMappings = (): unknown[] => {
  return [];
};
