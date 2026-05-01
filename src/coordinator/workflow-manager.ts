import { randomUUID } from "node:crypto";

import type { WorkflowRun, WorkflowStatus } from "../shared/types.js";
import type { PollResult } from "../shared/types.js";

import {
  saveWorkflowRun,
  loadWorkflowRun,
  listWorkflowRuns,
} from "../state-store/index.js";

const deriveBranch = (issueNumber: number): string =>
  `auto-dev/issue-${issueNumber}`;

export class WorkflowManager {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async createRun(
    result: PollResult,
    repoFullName: string,
  ): Promise<WorkflowRun> {
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: randomUUID(),
      issueNumber: result.issueNumber,
      repoFullName,
      status: "pending",
      branch: deriveBranch(result.issueNumber),
      agentModel: result.agentModel,
      agentEffort: result.agentEffort,
      agentDefinition: result.agentDefinition,
      startedAt: now,
      updatedAt: now,
      decisionCount: 0,
      pendingDecisionIds: [],
      prNumber: null,
    };

    await saveWorkflowRun(this.workspaceRoot, run);
    return run;
  }

  async updateStatus(runId: string, status: WorkflowStatus): Promise<void> {
    const run = loadWorkflowRun(this.workspaceRoot, runId);
    if (!run) return;

    run.status = status;
    run.updatedAt = new Date().toISOString();
    await saveWorkflowRun(this.workspaceRoot, run);
  }

  listActive(): WorkflowRun[] {
    return listWorkflowRuns(this.workspaceRoot).filter(
      (r) => !["completed", "failed"].includes(r.status),
    );
  }

  listAll(): WorkflowRun[] {
    return listWorkflowRuns(this.workspaceRoot);
  }
}
