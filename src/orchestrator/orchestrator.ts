import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";

import type { WorkflowRun, WorkflowStatus } from "@/shared/types.js";

import {
  renderWorkspaceComment,
  renderDecisionComment,
  renderCompletionComment,
  renderIssueCompletionComment,
  renderRetriggerWorkingComment,
  renderRetriggerCompletionComment,
  renderWorkspaceReadyComment,
  renderIssueAgentResponse,
  renderCreatePRComment,
} from "@/shared/comment-templates.js";
import {
  createComment,
  getIssue,
  listIssueComments,
  listPRComments,
  listPRs,
  removeIssueLabels,
  updateIssueLabels,
  addCommentReaction,
  getIssueState,
  getPRState,
} from "@/shared/gh-cli.js";
import { logger } from "@/shared/logger.js";
import { isAllowedUser } from "@/shared/user-filter.js";
import {
  ensureStateDirs,
  saveWorkflowRun,
  saveCoordinatorState,
  loadWorkflowRun,
  listDecisions,
  listWorkflowRuns,
  unregisterWorkspace,
  listAllWorkspaces,
  isEventProcessed,
  markEventProcessed,
  cleanupProcessedEvents,
} from "@/state-store/index.js";

import type { AutoDevConfig } from "../config/types.js";
import type { WorkspaceInfo } from "../workspace-manager/index.js";

import { AgentDispatcher } from "../agent-dispatcher/index.js";
import { AuditLogger } from "../audit-logger/index.js";
import { loadConfig } from "../config/loader.js";
import { DecisionManager } from "../decision-service/decision-manager.js";
import { DecisionSocketServer } from "../decision-service/socket-server.js";
import { PRManager } from "../pr-manager/index.js";
import { WorkspaceManager } from "../workspace-manager/index.js";
import { IssueWatcher } from "./issues-watcher.js";
import { WorkflowManager } from "./workflow-manager.js";

/** Returns the TCP port for the decision server.
 * Reads AUTO_DEV_DECISION_PORT env var; defaults to 3000.
 */
const resolveDecisionPort = (): number => {
  const raw = process.env.AUTO_DEV_DECISION_PORT;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 3000;
};

/** Returns the host address advertised to agent containers so they can
 * connect back to the decision TCP server.
 * Reads AUTO_DEV_DECISION_HOST env var; falls back to the first non-loopback
 * IPv4 address (suitable for Docker-in-Docker scenarios where the orchestrator
 * is itself a container and workers are sibling containers).
 */
const resolveDecisionHost = (): string => {
  if (process.env.AUTO_DEV_DECISION_HOST)
    return process.env.AUTO_DEV_DECISION_HOST;
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (!iface.internal && iface.family === "IPv4") {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
};

export class Orchestrator {
  private readonly workspaceRoot: string;
  private readonly repoFullName: string;
  private config: AutoDevConfig | null = null;
  private socketServer: DecisionSocketServer | null = null;
  private decisionManager: DecisionManager | null = null;
  private workflowManager: WorkflowManager | null = null;
  private workspaceManager: WorkspaceManager | null = null;
  private dispatcher: AgentDispatcher | null = null;
  private auditLogger: AuditLogger | null = null;
  private prManager: PRManager | null = null;
  private issueWatcher: IssueWatcher | null = null;
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** TCP decision server host/port resolved at startup. */
  private decisionHost: string = "127.0.0.1";
  private decisionPort: number = 3000;
  private decisionToken: string = "";
  /** runId -> issueNumber for active runs */
  private readonly activeRuns: Map<string, number> = new Map();
  private commentPollTimer: ReturnType<typeof setTimeout> | null = null;
  private prTriggerPollTimer: ReturnType<typeof setTimeout> | null = null;
  private issueCommentPollTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecyclePollTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly COMMENT_POLL_INTERVAL_MS = 15_000;

  constructor(workspaceRoot: string, repoFullName: string) {
    this.workspaceRoot = workspaceRoot;
    this.repoFullName = repoFullName;
  }

  async start(): Promise<void> {
    this.config = await loadConfig(this.workspaceRoot);
    await ensureStateDirs(this.workspaceRoot);

    this.decisionPort = resolveDecisionPort();
    this.decisionHost = resolveDecisionHost();
    this.decisionToken = process.env.AUTO_DEV_DECISION_TOKEN ?? randomUUID();

    this.decisionManager = new DecisionManager(this.workspaceRoot, this.config);
    this.workflowManager = new WorkflowManager(this.workspaceRoot);
    this.workspaceManager = new WorkspaceManager(
      this.workspaceRoot,
      this.repoFullName,
    );
    await this.workspaceManager.getGitManager().ensureRepo();
    this.dispatcher = new AgentDispatcher();
    this.auditLogger = new AuditLogger(this.workspaceRoot);
    this.prManager = new PRManager(this.repoFullName);
    this.issueWatcher = new IssueWatcher();

    this.socketServer = new DecisionSocketServer({
      port: resolveDecisionPort(),
      config: this.config,
      workspaceRoot: this.workspaceRoot,
      decisionToken: this.decisionToken,
      onDecisionRequest: async (request) => {
        const result = await this.decisionManager!.receiveRequest(request);
        if (result.accepted) {
          const run = loadWorkflowRun(
            this.workspaceRoot,
            request.workflowRunId,
          );
          if (run) {
            const pending = listDecisions(this.workspaceRoot).filter(
              (d) =>
                d.workflowRunId === request.workflowRunId &&
                d.status === "pending",
            );
            const comment = renderDecisionComment(
              pending.map((d) => ({
                alias: d.alias,
                title: d.title,
                options: d.options,
                recommendation: d.recommendation,
                context: d.context,
              })),
              result.remainingDecisions,
            );
            const targetNumber = run.prNumber ?? run.issueNumber;
            try {
              createComment(this.repoFullName, targetNumber, comment);
            } catch {
              /* best-effort */
            }
          }
        }
        return result;
      },
      onBatchDecisionRequest: async (requests, batchId) => {
        const results = await this.decisionManager!.receiveBatch(
          requests,
          batchId,
        );
        const runId = requests[0]?.workflowRunId;
        if (runId) {
          const run = loadWorkflowRun(this.workspaceRoot, runId);
          if (run) {
            const pending = listDecisions(this.workspaceRoot).filter(
              (d) => d.workflowRunId === runId && d.status === "pending",
            );
            const comment = renderDecisionComment(
              pending.map((d) => ({
                alias: d.alias,
                title: d.title,
                options: d.options,
                recommendation: d.recommendation,
                context: d.context,
              })),
              (run.maxDecisions ?? this.config!.maxDecisionPerRun) -
              run.decisionCount,
            );
            const targetNumber = run.prNumber ?? run.issueNumber;
            try {
              createComment(this.repoFullName, targetNumber, comment);
            } catch {
              /* best-effort */
            }
          }
        }
        return results;
      },
      onGetResolution: async (decisionId) => {
        return this.decisionManager!.getResolution(decisionId);
      },
    });
    await this.socketServer.start();

    await saveCoordinatorState(this.workspaceRoot, {
      startedAt: new Date().toISOString(),
      pollIntervalSec: this.config.pollIntervalSec,
      activeRunIds: [],
    });

    // Startup cleanup: remove orphaned containers and stale registry entries
    await this.startupCleanup();

    // Reconstruct activeRuns from persisted state to avoid in-memory loss across restarts
    this.rebuildActiveRuns();

    this.polling = true;
    void this.pollLoop();
    this.startCommentPoller();
    this.startPRTriggerPoller();
    this.startIssueCommentPoller();
    this.startLifecyclePoller();
  }

  /**
   * Reconstruct the in-memory activeRuns map from persisted workflow state.
   * Prevents duplicate processing after container/process restart.
   */
  private rebuildActiveRuns(): void {
    const activeRunsFromStore = listWorkflowRuns(this.workspaceRoot).filter(
      (r) =>
        ![
          "completed",
          "failed",
          "workspace_ready",
          "cancelled",
          "stale",
          "abandoned",
          "cleaned",
        ].includes(r.status),
    );
    for (const run of activeRunsFromStore) {
      this.activeRuns.set(run.id, run.issueNumber);
    }
    if (activeRunsFromStore.length > 0) {
      logger.info(
        `[auto-dev] Restored ${activeRunsFromStore.length} active run(s) from persisted state`,
      );
    }
  }

  private async startupCleanup(): Promise<void> {
    logger.info("[auto-dev] Running startup cleanup...");

    // 1. Scan Docker for containers with autodev-worktree labels that have no
    //    corresponding SQLite registry entry, and clean them up.
    try {
      const dockerContainers = execFileSync(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          "label=autodev-worktree",
          "--format",
          '{{.ID}} {{.Label "autodev-worktree"}}',
        ],
        { encoding: "utf-8" },
      ).trim();

      if (dockerContainers) {
        const allWorkspaces = listAllWorkspaces(this.workspaceRoot);
        const registeredPaths = new Set(
          allWorkspaces.map((w) => w.worktreePath),
        );

        for (const line of dockerContainers.split("\n")) {
          const [containerId, worktreePath] = line.split(" ");
          if (
            containerId &&
            worktreePath &&
            !registeredPaths.has(worktreePath)
          ) {
            logger.info(
              `[auto-dev] Cleaning up orphaned container ${containerId} (${worktreePath})`,
            );
            try {
              execFileSync("docker", ["stop", "--time=30", containerId], {
                stdio: "ignore",
              });
            } catch {
              /* best-effort */
            }
            try {
              execFileSync("docker", ["rm", "--force", containerId], {
                stdio: "ignore",
              });
            } catch {
              /* best-effort */
            }
          }
        }
      }
    } catch {
      /* best-effort: docker may not be available */
    }

    // 2. Scan SQLite registry for entries whose containers no longer exist
    const allWorkspaces = listAllWorkspaces(this.workspaceRoot);
    for (const entry of allWorkspaces) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        let status: string;
        try {
          status = execFileSync(
            "docker",
            ["inspect", entry.containerId, "--format", "{{.State.Status}}"],
            { encoding: "utf-8" },
          ).trim();
        } catch {
          status = "not_found";
        }
        if (status === "not_found" || status === "") {
          logger.info(
            `[auto-dev] Cleaning up stale registry entry for issue #${entry.issueNumber} (container not found)`,
          );
          // oxlint-disable-next-line no-await-in-loop
          await unregisterWorkspace(this.workspaceRoot, entry.issueNumber);
        }
      } catch {
        /* best-effort */
      }
    }

    // 3. Prune stale git worktrees
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: this.workspaceRoot,
        stdio: "ignore",
      });
    } catch {
      /* best-effort */
    }

    try {
      const deleted = await cleanupProcessedEvents(this.workspaceRoot, 30);
      if (deleted > 0) {
        logger.info(`[auto-dev] Cleaned ${deleted} old processed comment cursor(s)`);
      }
    } catch {
      /* best-effort */
    }
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.commentPollTimer) clearTimeout(this.commentPollTimer);
    if (this.prTriggerPollTimer) clearTimeout(this.prTriggerPollTimer);
    if (this.issueCommentPollTimer) clearTimeout(this.issueCommentPollTimer);
    if (this.lifecyclePollTimer) clearTimeout(this.lifecyclePollTimer);
    await this.socketServer?.stop();
  }

  // ── Poll loops ───────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        const results = this.issueWatcher!.poll(
          this.repoFullName,
          this.config!,
          this.workspaceRoot,
        );

        const maxConcurrent = this.config!.maxConcurrentRuns;
        const available = maxConcurrent - this.activeRuns.size;
        const toProcess = results.slice(0, Math.max(0, available));

        if (results.length > toProcess.length) {
          logger.info(
            `[auto-dev] ${results.length} issue(s) ready, deferring ${results.length - toProcess.length} (concurrent limit: ${maxConcurrent})`,
          );
        }

        // oxlint-disable-next-line no-await-in-loop
        await Promise.all(
          toProcess.map(async (result) => this.handleNewIssue(result)),
        );
      } catch (err) {
        logger.error(`[auto-dev] Poll cycle error: ${String(err)}`);
      }

      // oxlint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        this.pollTimer = setTimeout(
          resolve,
          this.config!.pollIntervalSec * 1000,
        );
      });
    }
  }

  // ── Issue lifecycle ──────────────────────────────────────────────────

  private async handleNewIssue(
    result: import("@/shared/types.js").PollResult,
  ): Promise<void> {
    const run = await this.workflowManager!.createRun(
      result,
      this.repoFullName,
    );
    logger.info(
      `[auto-dev] Claimed issue #${result.issueNumber}, run ${run.id}`,
    );
    // NOTE: workspace_ready runs are NOT counted in activeRuns (concurrency limit)
    // They are added to activeRuns only when @autodev create-pr triggers the agent

    // 1. Claim: add label
    try {
      updateIssueLabels(this.repoFullName, result.issueNumber, [
        "auto-dev:claimed",
      ]);
    } catch (err) {
      logger.error(
        `[auto-dev] Failed to label issue #${result.issueNumber}: ${String(err)}`,
      );
    }

    // 2. Create workspace (branch + worktree + devcontainer)
    try {
      await this.workspaceManager!.createFromBase(
        result.issueNumber,
        run.id,
        run.baseBranch,
      );
      logger.info(
        `[auto-dev] Branch ${run.branch} + workspace created for issue #${result.issueNumber}`,
      );
    } catch (err) {
      logger.error(
        `[auto-dev] Failed to create workspace for #${result.issueNumber}: ${String(err)}`,
      );
      await this.workflowManager!.updateStatus(run.id, "failed");
      try {
        removeIssueLabels(this.repoFullName, result.issueNumber, [
          "auto-dev:ready",
          "auto-dev:claimed",
        ]);
      } catch {
        /* best-effort */
      }
      return;
    }

    // 3. Workspace ready: post comment and set status — PR will be created on demand
    await this.workflowManager!.updateStatus(run.id, "workspace_ready");

    try {
      createComment(
        this.repoFullName,
        result.issueNumber,
        renderWorkspaceReadyComment(run),
      );
    } catch (err) {
      logger.error(
        `[auto-dev] Failed to post workspace-ready comment for #${result.issueNumber}: ${String(err)}`,
      );
    }
  }

  // ── Issue @autodev comment trigger ──────────────────────────────────

  /** Handle `@autodev create-pr` or `@autodev <message>` in an issue comment. */
  private async handleIssueCommentTrigger(
    run: WorkflowRun,
    commentId: number,
    commentBody: string,
    author: string,
  ): Promise<void> {
    // Extract instruction after @autodev
    const match = commentBody.match(/@autodev\b(.*)/is);
    if (!match) return;
    const instruction = match[1].trim();

    // Add "eyes" reaction to acknowledge
    try {
      addCommentReaction(this.repoFullName, commentId, "eyes");
    } catch {
      /* best-effort */
    }

    if (/^create-pr(\s|$)/i.test(instruction)) {
      // Handle @autodev create-pr
      await this.handleCreatePR(run);
    } else {
      // Handle @autodev <message> — dispatch issue-responder agent
      await this.handleIssueAgentResponse(run, instruction, author);
    }
  }

  /** Create a Draft PR for the given workspace_ready run. */
  private async handleCreatePR(initialRun: WorkflowRun): Promise<void> {
    const run = await this.hydrateIssueContextIfMissing(initialRun);

    if (run.prNumber) {
      // PR already exists — check if it's still open
      try {
        const prState = getPRState(this.repoFullName, run.prNumber);
        if (prState.state === "OPEN") {
          logger.info(
            `[auto-dev] PR #${run.prNumber} already open for issue #${run.issueNumber} — skipping create-pr`,
          );
          try {
            createComment(
              this.repoFullName,
              run.issueNumber,
              `<!-- auto-dev-bot -->\n\nPR #${run.prNumber} is already open.`,
            );
          } catch {
            /* best-effort */
          }
          return;
        }
      } catch {
        /* continue to create PR */
      }
    }

    // Ensure workspace exists
    let workspaceInfo: WorkspaceInfo | null = null;
    try {
      workspaceInfo = await this.workspaceManager!.ensure(
        run.issueNumber,
        run.id,
        run.branch,
      );
    } catch (err) {
      logger.error(
        `[auto-dev] Failed to ensure workspace for create-pr issue #${run.issueNumber}: ${String(err)}`,
      );
      return;
    }

    // Commit + push
    try {
      const pushMeta = await this.workspaceManager!.getGitManager().commitAndPush(
        run.branch,
        `chore: auto-dev init for issue #${run.issueNumber}`,
        workspaceInfo.worktreePath,
      );
      run.lastPushedSha = pushMeta.pushedSha;
      run.lastObservedRemoteSha = pushMeta.observedRemoteSha;
      run.updatedAt = new Date().toISOString();
      await saveWorkflowRun(this.workspaceRoot, run);
    } catch (err) {
      logger.error(
        `[auto-dev] Failed to push for create-pr issue #${run.issueNumber}: ${String(err)}`,
      );
    }

    // Create Draft PR
    let prNumber: number | null = null;
    try {
      const prTitle = `[Auto-Dev] #${run.issueNumber}: ${run.issueTitle || "Untitled issue"}`;
      const prBody = [
        `Closes #${run.issueNumber}`,
        "",
        `Run ID: \`${run.id}\``,
        "",
        "---",
        "",
        "## Issue Context",
        "",
        `### ${run.issueTitle || `Issue #${run.issueNumber}`}`,
        "",
        run.issueBody || "(Issue body is empty)",
      ].join("\n");
      const pr = this.prManager!.create(
        run.branch,
        prTitle,
        prBody,
        run.baseBranch,
        true,
      );
      prNumber = pr.number;
      run.prNumber = prNumber;
      await saveWorkflowRun(this.workspaceRoot, run);

      logger.info(
        `[auto-dev] Draft PR #${prNumber} created for issue #${run.issueNumber}`,
      );

      try {
        createComment(
          this.repoFullName,
          prNumber,
          renderWorkspaceComment(run, {
            model: run.agentModel,
            effort: run.agentEffort,
            maxDecisions: run.maxDecisions ?? this.config!.maxDecisionPerRun,
            agentDefinition: run.agentDefinition,
            autoMerge: false,
            issueTitle: run.issueTitle || `Issue #${run.issueNumber}`,
            issueBody: run.issueBody,
          }),
        );
      } catch {
        /* best-effort */
      }

      try {
        createComment(
          this.repoFullName,
          run.issueNumber,
          renderCreatePRComment(run, prNumber, pr.url),
        );
      } catch {
        /* best-effort */
      }

      this.auditLogger!.log({
        id: randomUUID(),
        workflowRunId: run.id,
        timestamp: new Date().toISOString(),
        type: "pr_created",
        payload: { prNumber, branch: run.branch },
      });
    } catch (err) {
      logger.error(
        `[auto-dev] Draft PR creation failed for issue #${run.issueNumber}: ${String(err)}`,
      );
      try {
        createComment(
          this.repoFullName,
          run.issueNumber,
          `<!-- auto-dev-bot -->\n\nFailed to create Draft PR: ${String(err)}`,
        );
      } catch {
        /* best-effort */
      }
      return;
    }

    // Update status to running and dispatch agent
    await this.workflowManager!.updateStatus(run.id, "running");
    this.activeRuns.set(run.id, run.issueNumber);

    const agentDef = run.agentDefinition ?? this.config!.defaultAgent;
    const agentDefinitionFile = this.config!.agents[agentDef]?.definition;
    if (prNumber === null) {
      logger.error(
        `[auto-dev] Missing PR number for issue #${run.issueNumber}, aborting dispatch`,
      );
      return;
    }
    const issueContext = this.buildCreatePRIssueContext(
      run,
      prNumber,
      agentDef,
    );

    this.auditLogger!.log({
      id: randomUUID(),
      workflowRunId: run.id,
      timestamp: new Date().toISOString(),
      type: "workflow_started",
      payload: { provider: "claude-code", agentDef, trigger: "create_pr" },
    });

    try {
      let stdoutBuf = "";
      for await (const event of this.dispatcher!.dispatch("claude-code", {
        issueContext,
        agentDefinition: agentDef,
        agentDefinitionFile,
        model: run.agentModel,
        effort: run.agentEffort,
        maxTurns: run.maxTurns,
        permissionMode: run.permissionMode,
        workspaceRoot: this.workspaceRoot,
        agentWorkdir: workspaceInfo.containerId
          ? workspaceInfo.remoteWorkspaceFolder
          : workspaceInfo.worktreePath,
        containerId: workspaceInfo.containerId,
        workflowRunId: run.id,
        decisionHost: this.decisionHost,
        decisionPort: this.decisionPort,
        decisionToken: this.decisionToken,
      })) {
        if (event.type === "stdout" && event.data) {
          stdoutBuf += event.data;
          this.auditLogger!.log({
            id: randomUUID(),
            workflowRunId: run.id,
            timestamp: new Date().toISOString(),
            type: "phase_transition",
            payload: { chunk: event.data.slice(0, 2000) },
          });
        } else if (event.type === "stderr" && event.data) {
          logger.error(
            `[auto-dev] agent stderr [${run.id}]: ${event.data.slice(0, 500)}`,
          );
        } else if (event.type === "exit") {
          this.logTokenUsage(run.id, stdoutBuf);
          const code = event.exitCode ?? 0;
          const finalStatus = code === 0 ? "completed" : "failed";
          this.activeRuns.delete(run.id);
          await this.workflowManager!.updateStatus(run.id, finalStatus);

          if (workspaceInfo && run.branch && code === 0) {
            await this.workspaceManager!.getGitManager().tryPush(
              run.branch,
              workspaceInfo.worktreePath,
            );
          }

          if (code === 0 && prNumber) {
            // Auto-merge is intentionally disabled — PRs must be merged manually on GitHub.
          }

          this.auditLogger!.log({
            id: randomUUID(),
            workflowRunId: run.id,
            timestamp: new Date().toISOString(),
            type: code === 0 ? "workflow_completed" : "workflow_failed",
            payload: { exitCode: code },
          });

          try {
            removeIssueLabels(this.repoFullName, run.issueNumber, [
              "auto-dev:ready",
              "auto-dev:claimed",
            ]);
          } catch {
            /* best-effort */
          }

          const startedAt = new Date(run.startedAt).getTime();
          const durationSec = Math.round((Date.now() - startedAt) / 1000);
          const duration = `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
          let changedFiles = "";
          try {
            const { execSync } = await import("node:child_process");
            changedFiles = execSync("git diff --stat origin/main...HEAD", {
              encoding: "utf-8",
              cwd: workspaceInfo?.worktreePath ?? undefined,
            }).trim();
          } catch {
            /* best-effort */
          }

          const pushFn =
            workspaceInfo && run.branch
              ? async () =>
                this.workspaceManager!.getGitManager().tryPush(
                  run.branch,
                  workspaceInfo.worktreePath,
                )
              : null;

          if (prNumber) {
            await this.pushAndComment(
              pushFn,
              () => {
                createComment(
                  this.repoFullName,
                  prNumber,
                  renderCompletionComment(
                    run,
                    finalStatus,
                    code,
                    changedFiles,
                    run.decisionCount,
                    run.agentModel,
                    run.agentDefinition,
                    duration,
                  ),
                );
                createComment(
                  this.repoFullName,
                  run.issueNumber,
                  renderIssueCompletionComment(prNumber, finalStatus),
                );
              },
              `completion-run-${run.id}`,
            );
          } else {
            await this.pushAndComment(
              pushFn,
              () => {
                const emoji = code === 0 ? "completed" : "failed";
                createComment(
                  this.repoFullName,
                  run.issueNumber,
                  `<!-- auto-dev-bot -->\n\n**Auto-Dev** workflow **${emoji}** (exit ${code}).\n\nRun ID: \`${run.id}\``,
                );
              },
              `completion-run-${run.id}`,
            );
          }

          if (workspaceInfo) {
            await this.workspaceManager!.destroy(workspaceInfo);
            await unregisterWorkspace(this.workspaceRoot, run.issueNumber);
          }
        }
      }
    } catch (err) {
      logger.error(
        `[auto-dev] Agent dispatch error for run ${run.id}: ${String(err)}`,
      );
      this.activeRuns.delete(run.id);
      await this.workflowManager!.updateStatus(run.id, "failed");
      try {
        removeIssueLabels(this.repoFullName, run.issueNumber, [
          "auto-dev:ready",
          "auto-dev:claimed",
        ]);
      } catch {
        /* best-effort */
      }
      if (workspaceInfo) {
        await this.workspaceManager!.destroy(workspaceInfo);
        await unregisterWorkspace(this.workspaceRoot, run.issueNumber);
      }
    }
  }

  private buildCreatePRIssueContext(
    run: WorkflowRun,
    prNumber: number,
    agentDef: string,
  ): string {
    const labels =
      run.issueLabels.length > 0
        ? run.issueLabels.map((label) => `- ${label}`).join("\n")
        : "- (none)";
    return [
      "## Issue",
      "",
      `#${run.issueNumber} ${run.issueTitle || "Untitled issue"}`,
      "",
      run.issueBody || "(Issue body is empty)",
      "",
      "## Labels",
      "",
      labels,
      "",
      "## Run Configuration",
      "",
      `- Agent: ${agentDef}`,
      `- Model: ${run.agentModel ?? "default"}`,
      `- Effort: ${run.agentEffort ?? "default"}`,
      `- Max turns: ${run.maxTurns ?? "default"}`,
      `- Max decisions: ${run.maxDecisions ?? this.config!.maxDecisionPerRun}`,
      `- Permission mode: ${run.permissionMode ?? "default"}`,
      "",
      "## Workspace Instructions",
      "",
      "- Work in the current directory (the git worktree for this issue)",
      "- After making changes, stage and commit them with a descriptive commit message",
      "- Do NOT push — auto-dev will handle pushing",
      "",
      "## Metadata",
      `- Repo: ${this.repoFullName}`,
      `- Branch: ${run.branch}`,
      `- PR: #${prNumber}`,
      `- Run ID: ${run.id}`,
    ].join("\n");
  }

  private async hydrateIssueContextIfMissing(run: WorkflowRun): Promise<WorkflowRun> {
    if (run.issueTitle.trim() && run.issueBody.trim()) {
      return run;
    }

    try {
      const latest = getIssue(this.repoFullName, run.issueNumber);
      run.issueTitle = latest.title;
      run.issueBody = latest.body;
      run.issueLabels = latest.labels.map((label) => label.name);
      run.issueAuthor = latest.author?.login ?? null;
      run.updatedAt = new Date().toISOString();
      await saveWorkflowRun(this.workspaceRoot, run);
      return run;
    } catch (err) {
      logger.warn(
        `[auto-dev] Failed to hydrate issue context for #${run.issueNumber}: ${String(err)}`,
      );
      return run;
    }
  }

  /**
   * Parse a Claude Code stream-json stdout buffer and log token usage if a
   * `result` event with `usage` data is found.
   */
  private logTokenUsage(workflowRunId: string, rawStdout: string): void {
    for (const line of rawStdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type === "result" && parsed.usage) {
          this.auditLogger!.log({
            id: randomUUID(),
            workflowRunId,
            timestamp: new Date().toISOString(),
            type: "agent_usage",
            payload: {
              usage: parsed.usage,
              totalCostUsd: parsed.total_cost_usd ?? null,
              durationMs: parsed.duration_ms ?? null,
              numTurns: parsed.num_turns ?? null,
            },
          });
          return;
        }
      } catch {
        /* not JSON, skip */
      }
    }
  }

  /** Dispatch issue-responder agent and post result to issue comment. */
  private async handleIssueAgentResponse(
    run: WorkflowRun,
    instruction: string,
    _author: string,
  ): Promise<void> {
    // Ensure workspace
    let workspaceInfo: WorkspaceInfo | null = null;
    try {
      workspaceInfo = await this.workspaceManager!.ensure(
        run.issueNumber,
        run.id,
        run.branch,
      );
    } catch (err) {
      logger.error(
        `[auto-dev] Failed to ensure workspace for issue responder #${run.issueNumber}: ${String(err)}`,
      );
      return;
    }

    const issueContext = [
      `## Issue #${run.issueNumber}`,
      "",
      "## User Request",
      "",
      instruction,
      "",
      "## Instructions",
      "- You are working in the worktree for this issue",
      "- Respond with a helpful analysis or answer",
      "- Do NOT make code changes unless explicitly asked",
      "- Do NOT commit or push",
    ].join("\n");

    const agentDefinitionFile =
      this.config!.agents["issue-responder"]?.definition ??
      ".claude/agents/issue-responder.md";

    let rawStdout = "";
    try {
      for await (const event of this.dispatcher!.dispatch("claude-code", {
        issueContext,
        agentDefinition: "issue-responder",
        agentDefinitionFile,
        model: run.agentModel,
        effort: run.agentEffort,
        maxTurns: run.maxTurns,
        permissionMode: run.permissionMode,
        workspaceRoot: this.workspaceRoot,
        agentWorkdir: workspaceInfo.containerId
          ? workspaceInfo.remoteWorkspaceFolder
          : workspaceInfo.worktreePath,
        containerId: workspaceInfo.containerId,
        workflowRunId: run.id,
        decisionHost: this.decisionHost,
        decisionPort: this.decisionPort,
        decisionToken: this.decisionToken,
      })) {
        if (event.type === "stdout" && event.data) {
          rawStdout += event.data;
        } else if (event.type === "exit") {
          this.logTokenUsage(run.id, rawStdout);
          break;
        }
      }
    } catch (err) {
      logger.error(
        `[auto-dev] Issue responder agent error for #${run.issueNumber}: ${String(err)}`,
      );
      return;
    }

    // Claude emits a JSON event stream; extract the final `result` text.
    let responseText = "";
    for (const line of rawStdout.split("\n")) {
      try {
        const raw: unknown = JSON.parse(line);
        if (
          raw !== null &&
          typeof raw === "object" &&
          "type" in raw &&
          "subtype" in raw &&
          "result" in raw
        ) {
          const parsed = raw as {
            type: unknown;
            subtype: unknown;
            result: unknown;
          };
          if (
            parsed.type === "result" &&
            parsed.subtype === "success" &&
            typeof parsed.result === "string"
          ) {
            responseText = parsed.result;
            break;
          }
        }
      } catch {
        /* not JSON, skip */
      }
    }
    // Fall back to raw stdout if no structured result found
    if (!responseText) {
      responseText = rawStdout;
    }

    // Post agent response as issue comment
    const trimmed = responseText.trim();
    if (trimmed) {
      try {
        createComment(
          this.repoFullName,
          run.issueNumber,
          renderIssueAgentResponse(trimmed),
        );
      } catch (err) {
        logger.error(
          `[auto-dev] Failed to post agent response for issue #${run.issueNumber}: ${String(err)}`,
        );
      }
    }
  }

  // ── Issue comment poller (workspace_ready runs) ──────────────────────

  private startIssueCommentPoller(): void {
    const poll = async () => {
      try {
        const workspaceReadyRuns = listWorkflowRuns(this.workspaceRoot).filter(
          (r) => r.status === "workspace_ready",
        );

        for (const run of workspaceReadyRuns) {
          // oxlint-disable-next-line no-await-in-loop
          await this.pollIssueCommentsForRun(run);
        }
      } catch (err) {
        logger.error(`[auto-dev] Issue comment poller error: ${String(err)}`);
      }
      this.issueCommentPollTimer = setTimeout(
        () => void poll(),
        Orchestrator.COMMENT_POLL_INTERVAL_MS,
      );
    };
    this.issueCommentPollTimer = setTimeout(
      () => void poll(),
      Orchestrator.COMMENT_POLL_INTERVAL_MS,
    );
  }

  private async pollIssueCommentsForRun(run: WorkflowRun): Promise<void> {
    try {
      const comments = listIssueComments(this.repoFullName, run.issueNumber);
      for (const comment of comments) {
        if (
          isEventProcessed(this.workspaceRoot, "issue_trigger", comment.id)
        ) {
          continue;
        }
        if (comment.body.includes("<!-- auto-dev-bot -->")) continue;

        const author = comment.user?.login ?? comment.author?.login ?? "";
        if (author && !isAllowedUser(author)) continue;

        if (!/@autodev\b/i.test(comment.body)) continue;

        logger.info(
          `[auto-dev] Issue #${run.issueNumber} @autodev trigger from @${author}`,
        );

        // Only one trigger at a time per run
        // oxlint-disable-next-line no-await-in-loop
        await this.handleIssueCommentTrigger(
          run,
          parseInt(comment.id, 10),
          comment.body,
          author,
        );
        // oxlint-disable-next-line no-await-in-loop
        await markEventProcessed(this.workspaceRoot, {
          handler: "issue_trigger",
          githubCommentId: comment.id,
          repoFullName: this.repoFullName,
          issueOrPrNumber: run.issueNumber,
        });
        break;
      }
    } catch (err) {
      logger.error(
        `[auto-dev] Issue comment poll error for #${run.issueNumber}: ${String(err)}`,
      );
    }
  }

  // ── Lifecycle poller (cleanup closed issues / merged PRs) ───────────

  private startLifecyclePoller(): void {
    const LIFECYCLE_POLL_INTERVAL_MS = 60_000;
    const poll = async () => {
      try {
        await this.lifecycleCheck();
      } catch (err) {
        logger.error(`[auto-dev] Lifecycle poller error: ${String(err)}`);
      }
      this.lifecyclePollTimer = setTimeout(
        () => void poll(),
        LIFECYCLE_POLL_INTERVAL_MS,
      );
    };
    this.lifecyclePollTimer = setTimeout(
      () => void poll(),
      LIFECYCLE_POLL_INTERVAL_MS,
    );
  }

  private async lifecycleCheck(): Promise<void> {
    const runs = listWorkflowRuns(this.workspaceRoot).filter(
      (r) => r.status === "workspace_ready" || r.status === "running",
    );

    for (const run of runs) {
      try {
        // Check if issue is closed
        // oxlint-disable-next-line no-await-in-loop
        const issueState = getIssueState(this.repoFullName, run.issueNumber);
        if (issueState !== "OPEN") {
          logger.info(
            `[auto-dev] Issue #${run.issueNumber} is closed — cleaning up workspace`,
          );
          // oxlint-disable-next-line no-await-in-loop
          await this.cleanupRun(run, "cancelled");
          continue;
        }

        // Check if PR is merged
        if (run.prNumber) {
          // oxlint-disable-next-line no-await-in-loop
          const prState = getPRState(this.repoFullName, run.prNumber);
          if (prState.state === "MERGED") {
            logger.info(
              `[auto-dev] PR #${run.prNumber} merged — cleaning up workspace for issue #${run.issueNumber}`,
            );
            // oxlint-disable-next-line no-await-in-loop
            await this.cleanupRun(run, "completed");
          }
        }
      } catch {
        /* best-effort: gh call may fail for deleted issues */
      }
    }
  }

  private async cleanupRun(
    run: WorkflowRun,
    finalStatus: WorkflowStatus = "cleaned",
  ): Promise<void> {
    try {
      const allWorkspaces = listAllWorkspaces(this.workspaceRoot);
      const ws = allWorkspaces.find((w) => w.issueNumber === run.issueNumber);
      if (ws) {
        // oxlint-disable-next-line no-unsafe-type-assertion
        await this.workspaceManager!.destroy(ws as unknown as WorkspaceInfo);
      }
    } catch {
      /* best-effort */
    }
    try {
      await unregisterWorkspace(this.workspaceRoot, run.issueNumber);
    } catch {
      /* best-effort */
    }
    try {
      await this.workflowManager!.updateStatus(run.id, finalStatus);
    } catch {
      /* best-effort */
    }
    this.activeRuns.delete(run.id);
  }

  // ── PR re-trigger (@autodev) ─────────────────────────────────────────

  private async handlePRTrigger(
    run: WorkflowRun,
    commentBody: string,
    prNumber: number,
  ): Promise<void> {
    const { parseFrontmatter, stripFrontmatter } =
      await import("@/shared/frontmatter-parser.js");
    const frontmatterConfig = parseFrontmatter(commentBody);

    const model = frontmatterConfig?.model ?? run.agentModel;
    const effort = frontmatterConfig?.effort ?? run.agentEffort;

    const instruction = stripFrontmatter(commentBody).trim();

    // Auto-select pr-reviewer agent when the instruction starts with "review"
    const isReviewRequest = /^\s*@autodev\s+review\b/i.test(commentBody);
    const resolvedAgent =
      frontmatterConfig?.agent ??
      (isReviewRequest ? "pr-reviewer" : "retrigger");

    const agentDefinition = resolvedAgent;
    const retriggerDefinitionFile =
      this.config!.agents[agentDefinition]?.definition;

    const issueContext = [
      "## Re-Trigger on PR #" + prNumber,
      "",
      `PR: #${prNumber}`,
      `REPO: ${this.repoFullName}`,
      "Original Issue: #" + run.issueNumber,
      "Branch: " + run.branch,
      "Run ID: " + run.id,
      "",
      "## Instruction",
      "",
      instruction,
    ].join("\n");

    logger.info(
      `[auto-dev] Dispatching re-trigger agent "${agentDefinition}" for PR #${prNumber}`,
    );

    // Ensure workspace exists for re-trigger
    let workspaceInfo: WorkspaceInfo | null = null;
    try {
      workspaceInfo = await this.workspaceManager!.ensure(
        run.issueNumber,
        run.id,
        run.branch,
      );
    } catch (err) {
      logger.error(
        `[auto-dev] Failed to ensure workspace for re-trigger PR #${prNumber}: ${String(err)}`,
      );
      return;
    }

    // Post "Working" comment
    try {
      createComment(
        this.repoFullName,
        prNumber,
        renderRetriggerWorkingComment(run, agentDefinition, instruction),
      );
    } catch {
      /* best-effort */
    }

    // Sync worktree to latest remote state before dispatching agent
    try {
      this.workspaceManager!.getGitManager().syncWorktree(
        run.branch,
        workspaceInfo.worktreePath,
      );
    } catch {
      /* best-effort */
    }

    this.auditLogger!.log({
      id: randomUUID(),
      workflowRunId: run.id,
      timestamp: new Date().toISOString(),
      type: "workflow_started",
      payload: {
        provider: "claude-code",
        agentDef: agentDefinition,
        trigger: "pr_comment",
      },
    });

    try {
      let retriggerStdout = "";
      for await (const event of this.dispatcher!.dispatch("claude-code", {
        issueContext,
        agentDefinition,
        agentDefinitionFile: retriggerDefinitionFile,
        model,
        effort,
        maxTurns: run.maxTurns,
        permissionMode: run.permissionMode,
        workspaceRoot: this.workspaceRoot,
        agentWorkdir: workspaceInfo.containerId
          ? workspaceInfo.remoteWorkspaceFolder
          : workspaceInfo.worktreePath,
        containerId: workspaceInfo.containerId,
        workflowRunId: run.id,
        decisionHost: this.decisionHost,
        decisionPort: this.decisionPort,
        decisionToken: this.decisionToken,
      })) {
        if (event.type === "stdout" && event.data) {
          retriggerStdout += event.data;
        } else if (event.type === "exit") {
          this.logTokenUsage(run.id, retriggerStdout);
          const code = event.exitCode ?? 0;
          logger.info(
            `[auto-dev] Re-trigger agent for PR #${prNumber} completed (exit ${code})`,
          );
          await this.pushAndComment(
            async () =>
              this.workspaceManager!.getGitManager().tryPush(
                run.branch,
                workspaceInfo.worktreePath,
              ),
            () => {
              createComment(
                this.repoFullName,
                prNumber,
                renderRetriggerCompletionComment(run, agentDefinition, code),
              );
            },
            `retrigger-completion-pr-${prNumber}`,
            45,
            20_000,
            true,
          );
        }
      }
    } catch (err) {
      logger.error(
        `[auto-dev] Re-trigger agent error for PR #${prNumber}: ${String(err)}`,
      );
      try {
        createComment(
          this.repoFullName,
          prNumber,
          renderRetriggerCompletionComment(run, agentDefinition, 1),
        );
      } catch {
        /* best-effort */
      }
    } finally {
      if (workspaceInfo) {
        await this.workspaceManager!.destroy(workspaceInfo);
        await unregisterWorkspace(this.workspaceRoot, run.issueNumber);
      }
    }
  }

  // ── Comment resolution ──────────────────────────────────────────────

  private collectResolutionTasks(
    comments: Array<{
      id: string;
      body: string;
      user?: { login: string };
      author?: { login: string };
    }>,
    runId: string,
    handler: "issue_decision_resolution" | "pr_decision_resolution",
  ): Array<{
    commentId: string;
    decisionId: string;
    choice: string;
    author: string;
    alias: string;
  }> {
    const tasks: Array<{
      commentId: string;
      decisionId: string;
      choice: string;
      author: string;
      alias: string;
    }> = [];
    for (const comment of comments) {
      if (isEventProcessed(this.workspaceRoot, handler, comment.id)) continue;
      if (comment.body.includes("<!-- auto-dev-bot -->")) continue;
      const author = comment.user?.login ?? comment.author?.login ?? "";
      if (author && !isAllowedUser(author)) continue;
      const matches = [...comment.body.matchAll(/@(d\d+)\s+(\S+)/gi)];
      for (const [, rawAlias, choice] of matches) {
        const alias = rawAlias.toLowerCase();
        const pending = listDecisions(this.workspaceRoot).find(
          (d) =>
            d.workflowRunId === runId &&
            d.alias === alias &&
            d.status === "pending",
        );
        if (pending) {
          tasks.push({
            commentId: comment.id,
            decisionId: pending.id,
            choice,
            author,
            alias,
          });
        }
      }
    }
    return tasks;
  }

  private async processIssueComments(
    issueNumber: number,
    runId: string,
  ): Promise<void> {
    try {
      const comments = listIssueComments(this.repoFullName, issueNumber);
      const tasks = this.collectResolutionTasks(
        comments,
        runId,
        "issue_decision_resolution",
      );
      const consumedCommentIds = new Set<string>();
      await Promise.all(
        tasks.map(async ({ commentId, decisionId, choice, author, alias }) => {
          try {
            await this.decisionManager!.resolve(
              decisionId,
              choice,
              author,
              "issue_comment",
            );
            consumedCommentIds.add(commentId);
            logger.info(
              `[auto-dev] Resolved ${decisionId} (${alias}) via issue comment by ${author} -> ${choice}`,
            );
          } catch (err) {
            consumedCommentIds.add(commentId);
            logger.warn(
              `[auto-dev] Failed to resolve ${decisionId} (${alias}) via issue comment: ${String(err)}`,
            );
          }
        }),
      );

      await Promise.all(
        [...consumedCommentIds].map(async (commentId) =>
          markEventProcessed(this.workspaceRoot, {
            handler: "issue_decision_resolution",
            githubCommentId: commentId,
            repoFullName: this.repoFullName,
            issueOrPrNumber: issueNumber,
          }),
        ),
      );
    } catch (err) {
      logger.error(
        `[auto-dev] Comment poll error for issue #${issueNumber}: ${String(err)}`,
      );
    }
  }

  private async processPRComments(
    prNumber: number,
    runId: string,
  ): Promise<void> {
    try {
      const comments = listPRComments(this.repoFullName, prNumber);
      const tasks = this.collectResolutionTasks(
        comments,
        runId,
        "pr_decision_resolution",
      );
      const consumedCommentIds = new Set<string>();
      await Promise.all(
        tasks.map(async ({ commentId, decisionId, choice, author, alias }) => {
          try {
            await this.decisionManager!.resolve(
              decisionId,
              choice,
              author,
              "pr_comment",
            );
            consumedCommentIds.add(commentId);
            logger.info(
              `[auto-dev] Resolved ${decisionId} (${alias}) via PR comment by ${author} -> ${choice}`,
            );
          } catch (err) {
            consumedCommentIds.add(commentId);
            logger.warn(
              `[auto-dev] Failed to resolve ${decisionId} (${alias}) via PR comment: ${String(err)}`,
            );
          }
        }),
      );

      await Promise.all(
        [...consumedCommentIds].map(async (commentId) =>
          markEventProcessed(this.workspaceRoot, {
            handler: "pr_decision_resolution",
            githubCommentId: commentId,
            repoFullName: this.repoFullName,
            issueOrPrNumber: prNumber,
          }),
        ),
      );
    } catch (err) {
      logger.error(
        `[auto-dev] PR comment poll error for PR #${prNumber}: ${String(err)}`,
      );
    }
  }

  private startCommentPoller(): void {
    const poll = async () => {
      if (this.activeRuns.size > 0) {
        await Promise.all(
          [...this.activeRuns.entries()].map(async ([runId, issueNumber]) => {
            await this.processIssueComments(issueNumber, runId);
            const run = loadWorkflowRun(this.workspaceRoot, runId);
            if (run?.prNumber) {
              await this.processPRComments(run.prNumber, runId);
            }
          }),
        );
      }
      this.commentPollTimer = setTimeout(
        () => void poll(),
        Orchestrator.COMMENT_POLL_INTERVAL_MS,
      );
    };
    this.commentPollTimer = setTimeout(
      () => void poll(),
      Orchestrator.COMMENT_POLL_INTERVAL_MS,
    );
  }

  private startPRTriggerPoller(): void {
    const poll = async () => {
      try {
        const prs = listPRs(this.repoFullName, "open");
        const autoDevPRs = prs.filter((pr) =>
          pr.headRefName.startsWith("auto-dev/issue-"),
        );

        for (const pr of autoDevPRs) {
          const comments = listPRComments(this.repoFullName, pr.number);

          for (const comment of comments) {
            if (
              isEventProcessed(this.workspaceRoot, "pr_trigger", comment.id)
            ) {
              continue;
            }

            if (comment.body.includes("<!-- auto-dev-bot -->")) continue;
            const author = comment.user?.login ?? comment.author?.login ?? "";
            if (author === "auto-dev[bot]") continue;
            if (author && !isAllowedUser(author)) continue;

            const match = comment.body.match(/@autodev\b/i);
            if (!match) continue;

            const instruction = comment.body
              .slice(match.index! + "@autodev".length)
              .trim();
            if (!instruction) continue;

            logger.info(
              `[auto-dev] PR #${pr.number} trigger detected from @${author}: "${instruction.slice(0, 80)}"`,
            );

            const runs = this.workflowManager!.listAll();
            const run = runs.find((r) => r.prNumber === pr.number);
            if (!run) {
              logger.warn(
                `[auto-dev] No WorkflowRun found for PR #${pr.number}`,
              );
              continue;
            }

            // oxlint-disable-next-line no-await-in-loop
            await this.handlePRTrigger(run, comment.body, pr.number);
            // oxlint-disable-next-line no-await-in-loop
            await markEventProcessed(this.workspaceRoot, {
              handler: "pr_trigger",
              githubCommentId: comment.id,
              repoFullName: this.repoFullName,
              issueOrPrNumber: pr.number,
            });
            break;
          }
        }
      } catch (err) {
        logger.error(`[auto-dev] PR trigger poller error: ${String(err)}`);
      }
      this.prTriggerPollTimer = setTimeout(
        () => void poll(),
        (this.config?.pollIntervalSec ?? 30) * 1000,
      );
    };
    this.prTriggerPollTimer = setTimeout(
      () => void poll(),
      (this.config?.pollIntervalSec ?? 30) * 1000,
    );
  }

  // ── Shared helpers ──────────────────────────────────────────────────

  private async pushAndComment(
    pushFn: (() => Promise<boolean>) | null,
    commentFn: () => void,
    label = "comment",
    maxAttempts = 45,
    delayMs = 20_000,
    requirePushFirst = false,
  ): Promise<void> {
    let commented = false;
    for (let i = 0; i < maxAttempts; i += 1) {
      let pushOk = pushFn === null;
      if (pushFn) {
        // oxlint-disable-next-line no-await-in-loop
        pushOk = await pushFn();
      }
      if (!commented && (!requirePushFirst || pushOk)) {
        try {
          commentFn();
          commented = true;
        } catch {
          /* will retry */
        }
      }
      if (commented) return;
      if (i < maxAttempts - 1) {
        logger.warn(
          `[auto-dev] ${label} attempt ${i + 1}/${maxAttempts} failed, retrying in ${Math.round(delayMs / 1000)}s...`,
        );
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    logger.warn(`[auto-dev] ${label}: all ${maxAttempts} attempts exhausted`);
  }
}
