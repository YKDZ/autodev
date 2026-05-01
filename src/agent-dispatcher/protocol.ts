export type AgentEventType = "stdout" | "stderr" | "exit" | "error";

export interface AgentEvent {
  type: AgentEventType;
  data?: string;
  exitCode?: number;
}

export interface AgentContext {
  issueContext: string;
  agentDefinition: string;
  /** Filename (with extension) of the agent definition file, relative to the agents directory.
   * When set, takes priority over the default `${agentDefinition}.md` lookup. */
  agentDefinitionFile?: string;
  model: string | null;
  effort: string | null;
  /** Main workspace root (used for state/logs and agent definition lookup). */
  workspaceRoot: string;
  /** Working directory for the agent process. Defaults to workspaceRoot when not set. */
  agentWorkdir?: string;
  /** Container ID for docker exec. When set, the agent runs inside the container instead of as a local subprocess. */
  containerId?: string;
  /** Workflow run ID, passed as AUTO_DEV_RUN_ID env var so agents can call auto-dev request-decision. */
  workflowRunId?: string;
}

export interface AgentInvoker {
  invoke(context: AgentContext): AsyncIterable<AgentEvent>;
}
