// ── Agent-related types ───────────────────────────────────────────────

export type AgentProvider = "claude-code" | "copilot";

export type AgentModel = string;

export type AgentEffort = "xhigh" | "high" | "medium" | "low" | "max";

// ── Workflow types ────────────────────────────────────────────────────

export type WorkflowStatus =
  | "pending"
  | "running"
  | "waiting_decision"
  | "waiting_human"
  | "blocked"
  | "completed"
  | "failed";

export interface WorkflowRun {
  id: string;
  issueNumber: number;
  repoFullName: string;
  status: WorkflowStatus;
  branch: string;
  agentModel: AgentModel | null;
  agentEffort: AgentEffort | null;
  agentDefinition: string | null;
  startedAt: string;
  updatedAt: string;
  decisionCount: number;
  pendingDecisionIds: string[];
  prNumber: number | null;
}

// ── Decision types ────────────────────────────────────────────────────

export interface DecisionOption {
  key: string;
  label: string;
  description: string;
}

export type DecisionStatus = "pending" | "resolved";

export type ResolutionChannel = "cli" | "issue_comment" | "pr_comment";

export interface DecisionBlock {
  id: string;
  workflowRunId: string;
  title: string;
  options: DecisionOption[];
  recommendation: string;
  context: string | null;
  /** Short human-readable alias, e.g. "d1", "d2". Used for issue-comment resolution. */
  alias: string;
  status: DecisionStatus;
  resolution: string | null;
  resolvedBy: string | null;
  resolutionChannel: ResolutionChannel | null;
  requestedAt: string;
  resolvedAt: string | null;
  batchId: string | null;
  socketConnectionId: string | null;
}

export interface DecisionResponse {
  decisionId: string;
  title: string;
  resolution: string;
  resolvedBy: string;
  resolvedAt: string;
  remainingDecisions: number;
}

export interface DecisionRequest {
  id: string;
  workflowRunId: string;
  title: string;
  options: DecisionOption[];
  recommendation: string;
  context: string | null;
}

// ── Audit types ───────────────────────────────────────────────────────

export type AuditEventType =
  | "decision_requested"
  | "decision_blocked"
  | "decision_resolved"
  | "decision_unblocked"
  | "phase_transition"
  | "summary_published"
  | "agent_definition_selected"
  | "workflow_started"
  | "workflow_completed"
  | "workflow_failed"
  | "validation_requested"
  | "validation_passed"
  | "validation_failed"
  | "pr_created"
  | "pr_merged";

export interface AuditEvent {
  id: string;
  workflowRunId: string;
  timestamp: string;
  type: AuditEventType;
  payload: Record<string, unknown>;
}

// ── Agent definition types ────────────────────────────────────────────

export interface AgentRegistration {
  definition: string;
  description: string;
  defaultModel: AgentModel;
}

// ── Frontmatter types ─────────────────────────────────────────────────

export interface FrontmatterConfig {
  model: string | null;
  effort: AgentEffort | null;
  agent: string | null;
  maxDecisions: number | null;
  maxTurns: number | null;
  permissionMode: string | null;
}

// ── Workspace registry types ──────────────────────────────────────────

export interface WorkspaceRegistryEntry {
  issueNumber: number;
  runId: string;
  worktreePath: string;
  containerId: string;
  branch: string;
  createdAt: string; // ISO timestamp
}

// ── Poll result type ──────────────────────────────────────────────────

export interface PollResult {
  issueNumber: number;
  title: string;
  body: string;
  agentDefinition: string;
  agentModel: string | null;
  agentEffort: AgentEffort | null;
  maxTurns: number | null;
}
