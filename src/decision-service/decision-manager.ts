import type { AutoDevConfig } from "@/config/types.js";
import type {
  DecisionBlock,
  DecisionRequest,
  DecisionResponse,
} from "@/shared/types.js";

import {
  DecisionNotFoundError,
  InvalidDecisionChoiceError,
} from "@/shared/errors.js";
import {
  saveDecision,
  loadDecision,
  listDecisions,
  saveWorkflowRun,
  loadWorkflowRun,
  withTransaction,
} from "@/state-store/index.js";

export class DecisionManager {
  private readonly workspaceRoot: string;
  private readonly config: AutoDevConfig;

  constructor(workspaceRoot: string, config: AutoDevConfig) {
    this.workspaceRoot = workspaceRoot;
    this.config = config;
  }

  private resolveDecisionLimit(run: { maxDecisions: number | null }): number {
    return run.maxDecisions ?? this.config.maxDecisionPerRun;
  }

  async receiveRequest(request: DecisionRequest): Promise<{
    accepted: boolean;
    remainingDecisions: number;
    alias: string;
  }> {
    const run = loadWorkflowRun(this.workspaceRoot, request.workflowRunId);
    if (!run) {
      return { accepted: false, remainingDecisions: 0, alias: "" };
    }

    const decisionLimit = this.resolveDecisionLimit(run);

    if (run.decisionCount >= decisionLimit) {
      return { accepted: false, remainingDecisions: 0, alias: "" };
    }

    const remaining = decisionLimit - run.decisionCount;
    const alias = `d${run.decisionCount + 1}`;

    const decision: DecisionBlock = {
      id: request.id,
      workflowRunId: request.workflowRunId,
      title: request.title,
      options: request.options,
      recommendation: request.recommendation,
      context: request.context,
      alias,
      status: "pending",
      resolution: null,
      resolvedBy: null,
      resolutionChannel: null,
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      batchId: null,
      socketConnectionId: null,
    };

    await saveDecision(this.workspaceRoot, decision);

    run.status = "waiting_decision";
    run.decisionCount += 1;
    run.pendingDecisionIds = [...run.pendingDecisionIds, request.id];
    run.updatedAt = new Date().toISOString();
    await saveWorkflowRun(this.workspaceRoot, run);

    return { accepted: true, remainingDecisions: remaining - 1, alias };
  }

  async receiveBatch(
    requests: DecisionRequest[],
    batchId: string,
  ): Promise<
    Array<{ accepted: boolean; id: string; alias: string; reason?: string }>
  > {
    const run = loadWorkflowRun(
      this.workspaceRoot,
      requests[0]?.workflowRunId ?? "",
    );

    if (!run) {
      return requests.map((r) => ({
        accepted: false,
        id: r.id,
        alias: "",
        reason: "Run not found",
      }));
    }

    const decisionLimit = this.resolveDecisionLimit(run);

    const results: Array<{
      accepted: boolean;
      id: string;
      alias: string;
      reason?: string;
    }> = [];

    await withTransaction(this.workspaceRoot, async () => {
      for (const request of requests) {
        if (run.decisionCount >= decisionLimit) {
          results.push({
            accepted: false,
            id: request.id,
            alias: "",
            reason: "Decision limit reached",
          });
          continue;
        }

        const alias = `d${run.decisionCount + 1}`;
        const decision: DecisionBlock = {
          id: request.id,
          workflowRunId: request.workflowRunId,
          title: request.title,
          options: request.options,
          recommendation: request.recommendation,
          context: request.context,
          alias,
          status: "pending",
          resolution: null,
          resolvedBy: null,
          resolutionChannel: null,
          requestedAt: new Date().toISOString(),
          resolvedAt: null,
          batchId,
          socketConnectionId: null,
        };

        // oxlint-disable-next-line no-await-in-loop
        await saveDecision(this.workspaceRoot, decision);
        run.decisionCount += 1;
        run.pendingDecisionIds = [...run.pendingDecisionIds, request.id];
        results.push({ accepted: true, id: request.id, alias });
      }

      run.status = "waiting_decision";
      run.updatedAt = new Date().toISOString();
      await saveWorkflowRun(this.workspaceRoot, run);
    });

    return results;
  }

  async resolve(
    decisionId: string,
    choice: string,
    resolvedBy: string,
    channel: "cli" | "issue_comment" | "pr_comment" = "cli",
  ): Promise<DecisionResponse> {
    const decision = loadDecision(this.workspaceRoot, decisionId);
    if (!decision) {
      throw new DecisionNotFoundError(decisionId);
    }

    if (decision.status === "resolved") {
      const run = loadWorkflowRun(this.workspaceRoot, decision.workflowRunId);
      const remaining = run
        ? this.resolveDecisionLimit(run) - run.decisionCount
        : 0;
      return {
        decisionId: decision.id,
        title: decision.title,
        resolution: decision.resolution!,
        resolvedBy: decision.resolvedBy!,
        resolvedAt: decision.resolvedAt!,
        remainingDecisions: remaining,
      };
    }

    const allowedChoices = decision.options.map((option) => option.key);
    if (!allowedChoices.includes(choice)) {
      throw new InvalidDecisionChoiceError(decision.id, choice, allowedChoices);
    }

    const now = new Date().toISOString();

    decision.status = "resolved";
    decision.resolution = choice;
    decision.resolvedBy = resolvedBy;
    decision.resolutionChannel = channel;
    decision.resolvedAt = now;
    await saveDecision(this.workspaceRoot, decision);

    const run = loadWorkflowRun(this.workspaceRoot, decision.workflowRunId);
    if (run) {
      run.status = "running";
      run.pendingDecisionIds = run.pendingDecisionIds.filter(
        (id) => id !== decisionId,
      );
      run.updatedAt = now;
      await saveWorkflowRun(this.workspaceRoot, run);

      const remaining = this.resolveDecisionLimit(run) - run.decisionCount;

      return {
        decisionId: decision.id,
        title: decision.title,
        resolution: choice,
        resolvedBy,
        resolvedAt: now,
        remainingDecisions: remaining,
      };
    }

    return {
      decisionId: decision.id,
      title: decision.title,
      resolution: choice,
      resolvedBy,
      resolvedAt: now,
      remainingDecisions: 0,
    };
  }

  listAll(): DecisionBlock[] {
    return listDecisions(this.workspaceRoot);
  }

  async getResolution(decisionId: string): Promise<DecisionResponse | null> {
    const decision = loadDecision(this.workspaceRoot, decisionId);
    if (!decision || decision.status !== "resolved") return null;

    const run = loadWorkflowRun(this.workspaceRoot, decision.workflowRunId);
    const remaining = run
      ? this.resolveDecisionLimit(run) - run.decisionCount
      : 0;

    return {
      decisionId: decision.id,
      title: decision.title,
      resolution: decision.resolution!,
      resolvedBy: decision.resolvedBy!,
      resolvedAt: decision.resolvedAt!,
      remainingDecisions: remaining,
    };
  }
}
