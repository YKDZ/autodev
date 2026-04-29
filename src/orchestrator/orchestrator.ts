import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AutoDevConfig } from "../config/types.js";
import type { WorkflowRun } from "../shared/types.js";

import { logger } from "../shared/logger.js";
import { IssueWatcher } from "./issues-watcher.js";
import { WorkflowManager } from "./workflow-manager.js";
import { WorkspaceManager } from "../workspace-manager/index.js";
import type { WorkspaceInfo } from "../workspace-manager/index.js";
import { AgentDispatcher } from "../agent-dispatcher/index.js";
import { PRManager } from "../pr-manager/index.js";
import { AuditLogger } from "../audit-logger/index.js";
import { DecisionManager } from "../decision-service/decision-manager.js";
import { DecisionSocketServer } from "../decision-service/socket-server.js";
import { loadConfig } from "../config/loader.js";
import {
  ensureStateDirs,
  saveWorkflowRun,
  saveCoordinatorState,
  loadWorkflowRun,
  listDecisions,
  unregisterWorkspace,
  listAllWorkspaces,
} from "../state-store/index.js";
import {
  renderClaimComment,
  renderWorkspaceComment,
  renderDecisionComment,
  renderCompletionComment,
  renderIssueCompletionComment,
  renderRetriggerWorkingComment,
  renderRetriggerCompletionComment,
} from "../shared/comment-templates.js";
import {
  createComment,
  listIssueComments,
  listPRComments,
  listPRs,
  removeIssueLabels,
  updateIssueLabels,
} from "../shared/gh-cli.js";
import { isAllowedUser } from "../shared/user-filter.js";

const DEFAULT_SOCKET_PATH = "/var/run/auto-dev.sock";

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
  /** runId -> issueNumber for active runs */
  private readonly activeRuns: Map<string, number> = new Map();
  /** GitHub comment IDs that have already been processed */
  private readonly processedCommentIds: Set<string> = new Set();
  private commentPollTimer: ReturnType<typeof setTimeout> | null = null;
  private prTriggerPollTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly COMMENT_POLL_INTERVAL_MS = 15_000;

  constructor(workspaceRoot: string, repoFullName: string) {
    this.workspaceRoot = workspaceRoot;
    this.repoFullName = repoFullName;
  }

  async start(): Promise<void> {
    this.config = await loadConfig(this.workspaceRoot);
    await ensureStateDirs(this.workspaceRoot);

    this.decisionManager = new DecisionManager(this.workspaceRoot, this.config);
    this.workflowManager = new WorkflowManager(this.workspaceRoot);
    this.workspaceManager = new WorkspaceManager(
      this.workspaceRoot,
      this.repoFullName,
    );
    this.dispatcher = new AgentDispatcher();
    this.auditLogger = new AuditLogger(this.workspaceRoot);
    this.prManager = new PRManager(this.repoFullName);
    this.issueWatcher = new IssueWatcher();

    this.socketServer = new DecisionSocketServer({
      socketPath: process.env.AUTO_DEV_SOCKET ?? DEFAULT_SOCKET_PATH,
      config: this.config,
      workspaceRoot: this.workspaceRoot,
      onDecisionRequest: async (request) => {
        const result = await this.decisionManager!.receiveRequest(request);
        if (result.accepted) {
          const run = loadWorkflowRun(this.workspaceRoot, request.workflowRunId);
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
        const results = await this.decisionManager!.receiveBatch(requests, batchId);
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
              this.config!.maxDecisionPerRun - run.decisionCount,
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

    this.polling = true;
    void this.pollLoop();
    this.startCommentPoller();
    this.startPRTriggerPoller();
  }

  private async startupCleanup(): Promise<void> {
    logger.info("[auto-dev] Running startup cleanup...");

    // 1. Scan Docker for containers with autodev-worktree labels that have no
    //    corresponding SQLite registry entry, and clean them up.
    try {
      const { execSync } = await import("node:child_process");
      const dockerContainers = execSync(
        "docker ps -a --filter label=autodev-worktree --format '{{.ID}} {{.Label \"autodev-worktree\"}}'",
        { encoding: "utf-8" },
      ).trim();

      if (dockerContainers) {
        const allWorkspaces = listAllWorkspaces(this.workspaceRoot);
        const registeredPaths = new Set(
          allWorkspaces.map((w) => w.worktreePath),
        );

        for (const line of dockerContainers.split("\n")) {
          const [containerId, worktreePath] = line.split(" ");
          if (containerId && worktreePath && !registeredPaths.has(worktreePath)) {
            logger.info(
              `[auto-dev] Cleaning up orphaned container ${containerId} (${worktreePath})`,
            );
            try {
              execSync(`docker stop --time=30 ${containerId} 2>/dev/null; docker rm --force ${containerId} 2>/dev/null`, { stdio: "ignore" });
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
        const { execSync } = await import("node:child_process");
        const status = execSync(
          `docker inspect ${entry.containerId} --format '{{.State.Status}}' 2>/dev/null || echo "not_found"`,
          { encoding: "utf-8" },
        ).trim();
        if (status === "not_found") {
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
      const { execSync } = await import("node:child_process");
      execSync("git worktree prune", { cwd: this.workspaceRoot, stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.commentPollTimer) clearTimeout(this.commentPollTimer);
    if (this.prTriggerPollTimer) clearTimeout(this.prTriggerPollTimer);
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

        // oxlint-disable-next-line no-await-in-loop
        await Promise.all(
          results.map(async (result) => this.handleNewIssue(result)),
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
    result: import("../shared/types.js").PollResult,
  ): Promise<void> {
    const run = await this.workflowManager!.createRun(
      result,
      this.repoFullName,
    );
    logger.info(
      `[auto-dev] Claimed issue #${result.issueNumber}, run ${run.id}`,
    );
    this.activeRuns.set(run.id, result.issueNumber);

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
    let workspaceInfo: WorkspaceInfo | null = null;
    try {
      workspaceInfo = await this.workspaceManager!.create(
        result.issueNumber,
        run.id,
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

    // 3. PR-First: initial commit, push, create PR
    let prNumber: number | null = null;
    try {
      const initFile = resolve(
        workspaceInfo.worktreePath,
        `.auto-dev-init-${run.id}.md`,
      );
      writeFileSync(
        initFile,
        `# Auto-Dev Run ${run.id}\n\nIssue: #${result.issueNumber}\nBranch: ${run.branch}\n`,
      );
      this.workspaceManager!.getGitManager().commitAndPush(
        run.branch,
        `chore: auto-dev init for issue #${result.issueNumber}`,
        workspaceInfo.worktreePath,
      );

      const prTitle = result.title;
      const prBody = `Closes #${result.issueNumber}\n\nRun ID: \`${run.id}\``;
      const pr = this.prManager!.create(run.branch, prTitle, prBody, "main");
      prNumber = pr.number;
      run.prNumber = prNumber;
      await saveWorkflowRun(this.workspaceRoot, run);

      logger.info(
        `[auto-dev] PR #${prNumber} created for issue #${result.issueNumber}`,
      );

      try {
        createComment(
          this.repoFullName,
          prNumber,
          renderWorkspaceComment(run, {
            model: result.agentModel,
            effort: result.agentEffort,
            maxDecisions: this.config!.maxDecisionPerRun,
            agentDefinition: result.agentDefinition,
            autoMerge: true,
            issueTitle: result.title,
            issueBody: result.body,
          }),
        );
      } catch (err) {
        logger.error(
          `[auto-dev] Failed to post PR workspace comment: ${String(err)}`,
        );
      }

      try {
        createComment(
          this.repoFullName,
          result.issueNumber,
          renderClaimComment(run, prNumber),
        );
      } catch (err) {
        logger.error(
          `[auto-dev] Failed to post claim comment: ${String(err)}`,
        );
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
        `[auto-dev] PR creation failed for #${result.issueNumber}: ${String(err)}`,
      );
      try {
        createComment(
          this.repoFullName,
          result.issueNumber,
          `<!-- auto-dev-bot -->\n\nPR creation failed: ${String(err)}. Branch pushed at \`${run.branch}\`.`,
        );
      } catch {
        /* best-effort */
      }
    }

    await this.workflowManager!.updateStatus(run.id, "running");
    const agentDef = result.agentDefinition || this.config!.defaultAgent;
    const agentDefinitionFile = this.config!.agents[agentDef]?.definition;

    const issueContext = [
      `## Issue #${result.issueNumber}: ${result.title}`,
      "",
      result.body,
      "",
      "## Metadata",
      `- Repo: ${this.repoFullName}`,
      `- Branch: ${run.branch}`,
      `- Run ID: ${run.id}`,
    ].join("\n");

    this.auditLogger!.log({
      id: randomUUID(),
      workflowRunId: run.id,
      timestamp: new Date().toISOString(),
      type: "workflow_started",
      payload: { provider: "claude-code", agentDef },
    });

    try {
      for await (const event of this.dispatcher!.dispatch("claude-code", {
        issueContext,
        agentDefinition: agentDef,
        agentDefinitionFile,
        model: result.agentModel,
        effort: result.agentEffort,
        workspaceRoot: this.workspaceRoot,
        agentWorkdir: workspaceInfo.worktreePath,
        containerId: workspaceInfo.containerId,
      })) {
        if (event.type === "stdout" && event.data) {
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
          const code = event.exitCode ?? 0;
          const finalStatus = code === 0 ? "completed" : "failed";
          this.activeRuns.delete(run.id);
          await this.workflowManager!.updateStatus(run.id, finalStatus);

          // Enable auto-merge on successful completion
          if (code === 0 && prNumber) {
            try {
              this.prManager!.enableAutoMerge(prNumber);
              logger.info(
                `[auto-dev] Auto-merge enabled for PR #${prNumber}`,
              );
            } catch (err) {
              logger.error(
                `[auto-dev] Failed to enable auto-merge for PR #${prNumber}: ${String(err)}`,
              );
            }
          }

          this.auditLogger!.log({
            id: randomUUID(),
            workflowRunId: run.id,
            timestamp: new Date().toISOString(),
            type: code === 0 ? "workflow_completed" : "workflow_failed",
            payload: { exitCode: code },
          });
          logger.info(
            `[auto-dev] Run ${run.id} finished with status=${finalStatus} (exit ${code})`,
          );
          try {
            removeIssueLabels(this.repoFullName, result.issueNumber, [
              "auto-dev:ready",
              "auto-dev:claimed",
            ]);
          } catch {
            /* best-effort */
          }

          // Build completion comment
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
              ? () =>
                  this.workspaceManager!.getGitManager().tryPush(
                    run.branch,
                    workspaceInfo.worktreePath,
                  )
              : null;

          if (run.prNumber) {
            const prCommentBody = renderCompletionComment(
              run,
              finalStatus,
              code,
              changedFiles,
              run.decisionCount,
              result.agentModel,
              result.agentDefinition,
              duration,
            );
            const issueCommentBody = renderIssueCompletionComment(
              run.prNumber,
              finalStatus,
            );
            await this.pushAndComment(
              pushFn,
              () => {
                createComment(this.repoFullName, run.prNumber!, prCommentBody);
                createComment(
                  this.repoFullName,
                  result.issueNumber,
                  issueCommentBody,
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
                  result.issueNumber,
                  `<!-- auto-dev-bot -->\n\n**Auto-Dev** workflow **${emoji}** (exit ${code}).\n\nRun ID: \`${run.id}\``,
                );
              },
              `completion-run-${run.id}`,
            );
          }

          // Clean up workspace
          if (workspaceInfo) {
            await this.workspaceManager!.destroy(workspaceInfo);
            await unregisterWorkspace(
              this.workspaceRoot,
              result.issueNumber,
            );
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
        removeIssueLabels(this.repoFullName, result.issueNumber, [
          "auto-dev:ready",
          "auto-dev:claimed",
        ]);
      } catch {
        /* best-effort */
      }
      if (workspaceInfo) {
        await this.workspaceManager!.destroy(workspaceInfo);
        await unregisterWorkspace(this.workspaceRoot, result.issueNumber);
      }
    }
  }

  // ── PR re-trigger (@autodev) ─────────────────────────────────────────

  private async handlePRTrigger(
    run: WorkflowRun,
    commentBody: string,
    prNumber: number,
  ): Promise<void> {
    const { parseFrontmatter, stripFrontmatter } = await import(
      "../shared/frontmatter-parser.js"
    );
    const frontmatterConfig = parseFrontmatter(commentBody);

    const agentDefinition = frontmatterConfig?.agent ?? "retrigger";
    const model = frontmatterConfig?.model ?? run.agentModel;
    const effort = frontmatterConfig?.effort ?? run.agentEffort;
    const retriggerDefinitionFile =
      this.config!.agents[agentDefinition]?.definition;

    const instruction = stripFrontmatter(commentBody).trim();

    const issueContext = [
      "## Re-Trigger on PR #" + prNumber,
      "",
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
      for await (const event of this.dispatcher!.dispatch("claude-code", {
        issueContext,
        agentDefinition,
        agentDefinitionFile: retriggerDefinitionFile,
        model,
        effort,
        workspaceRoot: this.workspaceRoot,
        agentWorkdir: workspaceInfo.worktreePath,
        containerId: workspaceInfo.containerId,
      })) {
        if (event.type === "exit") {
          const code = event.exitCode ?? 0;
          logger.info(
            `[auto-dev] Re-trigger agent for PR #${prNumber} completed (exit ${code})`,
          );
          await this.pushAndComment(
            () =>
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
  ): Array<{
    decisionId: string;
    choice: string;
    author: string;
    alias: string;
  }> {
    const tasks: Array<{
      decisionId: string;
      choice: string;
      author: string;
      alias: string;
    }> = [];
    for (const comment of comments) {
      if (this.processedCommentIds.has(comment.id)) continue;
      this.processedCommentIds.add(comment.id);
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
      const tasks = this.collectResolutionTasks(comments, runId);
      await Promise.all(
        tasks.map(async ({ decisionId, choice, author, alias }) => {
          try {
            await this.decisionManager!.resolve(
              decisionId,
              choice,
              author,
              "issue_comment",
            );
            logger.info(
              `[auto-dev] Resolved ${decisionId} (${alias}) via issue comment by ${author} -> ${choice}`,
            );
          } catch {
            /* ignore */
          }
        }),
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
      const tasks = this.collectResolutionTasks(comments, runId);
      await Promise.all(
        tasks.map(async ({ decisionId, choice, author, alias }) => {
          try {
            await this.decisionManager!.resolve(
              decisionId,
              choice,
              author,
              "pr_comment",
            );
            logger.info(
              `[auto-dev] Resolved ${decisionId} (${alias}) via PR comment by ${author} -> ${choice}`,
            );
          } catch {
            /* ignore */
          }
        }),
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
            if (this.processedCommentIds.has(comment.id)) continue;
            this.processedCommentIds.add(comment.id);

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
    pushFn: (() => boolean) | null,
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
        pushOk = pushFn();
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
