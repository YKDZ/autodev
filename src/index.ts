export const AUTO_DEV_VERSION = "0.0.1";

export type { AutoDevConfig, AgentRegistration } from "./config/types.js";
export { DEFAULT_CONFIG } from "./config/types.js";
export { AutoDevConfigSchema } from "./config/schema.js";

export type {
  WorkflowRun,
  DecisionBlock,
  DecisionResponse,
  AuditEvent,
  AgentProvider,
  AgentModel,
} from "./shared/types.js";

export { Orchestrator } from "./orchestrator/index.js";
export { WorkspaceManager } from "./workspace-manager/index.js";
export { PRManager } from "./pr-manager/index.js";
export { AgentDispatcher } from "./agent-dispatcher/index.js";

export { DecisionSocketServer } from "./decision-service/index.js";
export { DecisionManager } from "./decision-service/index.js";
export { ValidationGate } from "./validation/index.js";
export { AuditLogger } from "./audit-logger/index.js";
