// ── Agent-related types ───────────────────────────────────────────────

export type AgentProvider = "claude-code" | "copilot";

export type AgentModel = string;

export type AgentEffort = "xhigh" | "high" | "medium" | "low" | "max";

// ── Workflow types ────────────────────────────────────────────────────

export type WorkflowStatus =
  | "pending"
  | "running"
  | "workspace_ready"
  | "waiting_decision"
  | "waiting_human"
  | "blocked"
  | "cancelled"
  | "stale"
  | "abandoned"
  | "cleaned"
  | "completed"
  | "failed";

export interface WorkflowRun {
  id: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueLabels: string[];
  issueAuthor: string | null;
  repoFullName: string;
  status: WorkflowStatus;
  branch: string;
  agentModel: AgentModel | null;
  agentEffort: AgentEffort | null;
  agentDefinition: string | null;
  maxTurns: number | null;
  maxDecisions: number | null;
  permissionMode: string | null;
  baseBranch: string;
  startedAt: string;
  updatedAt: string;
  decisionCount: number;
  pendingDecisionIds: string[];
  prNumber: number | null;
  lastPushedSha: string | null;
  lastObservedRemoteSha: string | null;
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
  | "pr_merged"
  | "agent_usage";

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
  baseBranch: string | null;
}

// ── Workspace registry types ──────────────────────────────────────────

export interface WorkspaceRegistryEntry {
  issueNumber: number;
  runId: string;
  worktreePath: string;
  containerId: string;
  remoteWorkspaceFolder: string;
  containerSource: "devcontainer" | "fallback";
  image: string | null;
  branch: string;
  createdAt: string; // ISO timestamp
}

// ── Poll result type ──────────────────────────────────────────────────

export interface PollResult {
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  author: string | null;
  agentDefinition: string;
  agentModel: string | null;
  agentEffort: AgentEffort | null;
  maxDecisions: number | null;
  maxTurns: number | null;
  permissionMode: string | null;
  baseBranch: string;
}
