import { randomUUID } from "node:crypto";

import type { WorkflowRun, WorkflowStatus } from "@/shared/types.js";
import type { PollResult } from "@/shared/types.js";

import {
  saveWorkflowRun,
  loadWorkflowRun,
  listWorkflowRuns,
} from "@/state-store/index.js";

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
      issueTitle: result.title,
      issueBody: result.body,
      issueLabels: result.labels,
      issueAuthor: result.author,
      repoFullName,
      status: "pending",
      branch: deriveBranch(result.issueNumber),
      agentDefinition: result.agentDefinition,
      agentModel: result.agentModel,
      agentEffort: result.agentEffort,
      maxTurns: result.maxTurns,
      maxDecisions: result.maxDecisions,
      permissionMode: result.permissionMode,
      baseBranch: result.baseBranch,
      startedAt: now,
      updatedAt: now,
      decisionCount: 0,
      pendingDecisionIds: [],
      prNumber: null,
      lastPushedSha: null,
      lastObservedRemoteSha: null,
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
      (r) =>
        ![
          "completed",
          "failed",
          "cancelled",
          "abandoned",
          "cleaned",
          "stale",
        ].includes(r.status),
    );
  }

  listAll(): WorkflowRun[] {
    return listWorkflowRuns(this.workspaceRoot);
  }
}
