import { z } from "zod/v4";

export const GhIssueLabelSchema = z.object({
  name: z.string(),
});

export const GhIssueSchema = z.object({
  number: z.int(),
  title: z.string(),
  labels: z.array(GhIssueLabelSchema),
  body: z.string(),
  author: z.object({ login: z.string() }).optional(),
});

export type GhIssue = z.infer<typeof GhIssueSchema>;

export const GhPRSchema = z.object({
  number: z.int(),
  title: z.string(),
  headRefName: z.string(),
});

export type GhPR = z.infer<typeof GhPRSchema>;

export const GhCommentSchema = z.object({
  id: z.coerce.string(),
  body: z.string(),
  // REST API returns `user`, gh issue comment list --json returns `author`
  user: z.object({ login: z.string() }).optional(),
  author: z.object({ login: z.string() }).optional(),
});

export type GhComment = z.infer<typeof GhCommentSchema>;

export const DecisionOptionSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
});

export const DecisionRequestSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  title: z.string(),
  options: z.array(DecisionOptionSchema),
  recommendation: z.string(),
  context: z.string().nullable(),
});

export const WorkflowRunSchema = z.object({
  id: z.string(),
  issueNumber: z.int(),
  repoFullName: z.string(),
  status: z.enum([
    "pending",
    "running",
    "workspace_ready",
    "waiting_decision",
    "waiting_human",
    "blocked",
    "completed",
    "failed",
  ]),
  branch: z.string(),
  agentModel: z.string().nullable(),
  agentEffort: z.enum(["xhigh", "high", "medium", "low", "max"]).nullable(),
  agentDefinition: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  decisionCount: z.number(),
  pendingDecisionIds: z.array(z.string()),
  // Fields added later may be absent in older state files
  prNumber: z
    .int()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});

export const DecisionBlockSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  title: z.string(),
  options: z.array(DecisionOptionSchema),
  recommendation: z.string(),
  context: z.string().nullable(),
  alias: z.string(),
  status: z.enum(["pending", "resolved"]),
  resolution: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolutionChannel: z.enum(["cli", "issue_comment", "pr_comment"]).nullable(),
  requestedAt: z.string(),
  resolvedAt: z.string().nullable(),
  // Added later — may be absent in older files
  batchId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  socketConnectionId: z.string().nullable(),
});

export const AuditEventSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  timestamp: z.string(),
  type: z.enum([
    "decision_requested",
    "decision_blocked",
    "decision_resolved",
    "decision_unblocked",
    "phase_transition",
    "summary_published",
    "agent_definition_selected",
    "workflow_started",
    "workflow_completed",
    "workflow_failed",
    "validation_requested",
    "validation_passed",
    "validation_failed",
    "pr_created",
    "pr_merged",
  ]),
  payload: z.record(z.string(), z.unknown()),
});

export type WorkflowRunParsed = z.infer<typeof WorkflowRunSchema>;
export type DecisionBlockParsed = z.infer<typeof DecisionBlockSchema>;
