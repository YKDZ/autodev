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
  listIssues,
  removeIssueLabels,
  updateIssueLabels,
  addCommentReaction,
  getIssueState,
  getPRState,
  getReadyLabelAdder,
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
  isEventProcessedV2,
  markEventProcessedV2,
  cleanupProcessedEvents,
  upsertReadyIssueCandidate,
  listQueuedReadyIssueCandidates,
  updateReadyIssueCandidateStatus,
} from "@/state-store/index.js";

import type { AutoDevConfig } from "../config/types.js";
import type { WorkspaceInfo } from "../workspace-manager/index.js";

import { AgentDispatcher } from "../agent-dispatcher/index.js";
import { AuditLogger } from "../audit-logger/index.js";
import { loadConfig } from "../config/loader.js";
import { DecisionManager } from "../decision-service/decision-manager.js";
import { DecisionSocketServer } from "../decision-service/socket-server.js";
import { PRManager } from "../pr-manager/index.js";
import {
  EventQueue,
  GithubWebhookHandler,
  GithubWebhookServer,
  resolveWebhookPort,
  resolveWebhookPath,
  resolveWebhookSecret,
  resolveInsecureLocal,
  type WebhookHandlerContext,
} from "../webhook/index.js";
import { WorkspaceManager } from "../workspace-manager/index.js";
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
  private webhookServer: GithubWebhookServer | null = null;
  private eventQueue: EventQueue | null = null;
  /** TCP decision server host/port resolved at startup. */
  private decisionHost: string = "127.0.0.1";
  private decisionPort: number = 3000;
  private decisionToken: string = "";
  /** runId -> issueNumber for active runs */
  private readonly activeRuns: Map<string, number> = new Map();

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

    // One-time reconcile: catch up on any events missed while stopped
    if (process.env.AUTO_DEV_WEBHOOK_RECONCILE_ON_START !== "0") {
      await this.startupReconcile();
    }

    // Start webhook server
    this.eventQueue = new EventQueue();
    const handlerCtx: WebhookHandlerContext = {
      workspaceRoot: this.workspaceRoot,
      repoFullName: this.repoFullName,
      claimReadyIssue: async (
        issueNumber,
        issueTitle,
        issueBody,
        issueLabels,
        issueAuthor,
        senderLogin,
      ) =>
        this.claimReadyIssue(
          issueNumber,
          issueTitle,
          issueBody,
          issueLabels,
          issueAuthor,
          senderLogin,
        ),
      handleIssueAutodevComment: async (
        issueNumber,
        commentId,
        commentBody,
        author,
        resourceVersion,
      ) =>
        this.handleIssueAutodevComment(
          issueNumber,
          commentId,
          commentBody,
          author,
          resourceVersion,
        ),
      handlePRAutodevComment: async (
        prNumber,
        commentId,
        commentBody,
        author,
        resourceVersion,
      ) =>
        this.handlePRAutodevComment(
          prNumber,
          commentId,
          commentBody,
          author,
          resourceVersion,
        ),
      handleDecisionComment: async (
        issueOrPrNumber,
        commentId,
        commentBody,
        author,
        channel,
        resourceVersion,
      ) =>
        this.handleDecisionComment(
          issueOrPrNumber,
          commentId,
          commentBody,
          author,
          channel,
          resourceVersion,
        ),
      handleIssueClosed: async (issueNumber) =>
        this.handleIssueClosed(issueNumber),
      handlePRMerged: async (prNumber) => this.handlePRMerged(prNumber),
    };

    const webhookHandler = new GithubWebhookHandler(handlerCtx);
    this.eventQueue.setWorker(async (event) => webhookHandler.handle(event));

    const webhookSecret = resolveWebhookSecret();
    this.webhookServer = new GithubWebhookServer({
      port: resolveWebhookPort(),
      path: resolveWebhookPath(),
      secret: webhookSecret,
      insecureLocal: resolveInsecureLocal(),
      queue: this.eventQueue,
    });
    await this.webhookServer.start();
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
        logger.info(
          `[auto-dev] Cleaned ${deleted} old processed comment cursor(s)`,
        );
      }
    } catch {
      /* best-effort */
    }
  }

  async stop(): Promise<void> {
    await this.webhookServer?.stop();
    await this.socketServer?.stop();
  }

  // ── Startup reconcile ────────────────────────────────────────────────

  /**
   * One-time startup reconcile: catches up on events missed during downtime.
   * NOT a continuous poll — runs once at startup.
   */
  private async startupReconcile(): Promise<void> {
    logger.info("[auto-dev] Running startup reconcile...");

    const activeStatuses = [
      "pending",
      "running",
      "workspace_ready",
      "waiting_decision",
      "waiting_human",
      "blocked",
    ];

    const activeRuns = listWorkflowRuns(this.workspaceRoot).filter((r) =>
      activeStatuses.includes(r.status),
    );

    // Check lifecycle: closed issues and merged PRs
    for (const run of activeRuns) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        const issueState = getIssueState(this.repoFullName, run.issueNumber);
        if (issueState !== "open") {
          logger.info(
            `[auto-dev] Reconcile: issue #${run.issueNumber} is closed — cleaning up`,
          );
          // oxlint-disable-next-line no-await-in-loop
          await this.cleanupRun(run, "cancelled");
          continue;
        }

        if (run.prNumber) {
          // oxlint-disable-next-line no-await-in-loop
          const prState = getPRState(this.repoFullName, run.prNumber);
          if (prState.state === "MERGED") {
            logger.info(
              `[auto-dev] Reconcile: PR #${run.prNumber} merged — cleaning up`,
            );
            // oxlint-disable-next-line no-await-in-loop
            await this.cleanupRun(run, "completed");
          }
        }
      } catch {
        /* best-effort: gh call may fail for deleted issues */
      }
    }

    // Scan for new ready issues that haven't been claimed
    try {
      const issues = listIssues(this.repoFullName, "auto-dev:ready");
      const claimedIssues = new Set(
        listWorkflowRuns(this.workspaceRoot)
          .filter(
            (r) =>
              ![
                "completed",
                "failed",
                "cancelled",
                "abandoned",
                "cleaned",
                "stale",
              ].includes(r.status),
          )
          .map((r) => r.issueNumber),
      );

      for (const issue of issues) {
        if (claimedIssues.has(issue.number)) continue;
        const labelNames = issue.labels.map((l) =>
          typeof l === "string" ? l : l.name,
        );
        if (labelNames.includes("human-only")) continue;

        // Use label adder (not issue author) as the authorizing principal
        // oxlint-disable-next-line no-await-in-loop
        const labelAdder = getReadyLabelAdder(this.repoFullName, issue.number);
        const senderLogin = labelAdder ?? "";
        if (!senderLogin || !isAllowedUser(senderLogin)) {
          logger.info(
            `[auto-dev] Reconcile: skipping issue #${issue.number} — label adder "${senderLogin || "unknown"}" not authorized`,
          );
          continue;
        }

        // Queue as ready candidate (won't duplicate if already queued)
        upsertReadyIssueCandidate(this.workspaceRoot, {
          repoFullName: this.repoFullName,
          issueNumber: issue.number,
          senderLogin,
          payloadJson: JSON.stringify({ source: "reconcile" }),
        });
      }

      // Drain queued candidates
      await this.drainReadyIssueCandidates();
    } catch (err) {
      logger.error(`[auto-dev] Reconcile issue scan error: ${String(err)}`);
    }

    logger.info("[auto-dev] Startup reconcile complete");
  }

  /** Drain queued ready_issue_candidates up to maxConcurrentRuns. */
  private async drainReadyIssueCandidates(): Promise<void> {
    const maxConcurrent = this.config!.maxConcurrentRuns;
    const available = maxConcurrent - this.activeRuns.size;
    if (available <= 0) return;

    const candidates = listQueuedReadyIssueCandidates(
      this.workspaceRoot,
      this.repoFullName,
    ).slice(0, available);

    for (const candidate of candidates) {
      try {
        // Fetch fresh issue state before claiming
        // oxlint-disable-next-line no-await-in-loop
        const issue = getIssue(this.repoFullName, candidate.issueNumber);
        const issueState = getIssueState(
          this.repoFullName,
          candidate.issueNumber,
        );
        if (issueState !== "open") {
          updateReadyIssueCandidateStatus(
            this.workspaceRoot,
            candidate.issueNumber,
            this.repoFullName,
            "skipped",
            "Issue is not open",
          );
          continue;
        }

        const labelNames = issue.labels.map((l) => l.name);
        if (labelNames.includes("human-only")) {
          updateReadyIssueCandidateStatus(
            this.workspaceRoot,
            candidate.issueNumber,
            this.repoFullName,
            "skipped",
            "Issue has human-only label",
          );
          continue;
        }

        // oxlint-disable-next-line no-await-in-loop
        await this.claimReadyIssue(
          issue.number,
          issue.title,
          issue.body,
          labelNames,
          issue.author?.login ?? null,
          candidate.senderLogin,
        );
        updateReadyIssueCandidateStatus(
          this.workspaceRoot,
          candidate.issueNumber,
          this.repoFullName,
          "claimed",
        );
      } catch (err) {
        updateReadyIssueCandidateStatus(
          this.workspaceRoot,
          candidate.issueNumber,
          this.repoFullName,
          "failed",
          String(err),
        );
      }
    }
  }

  // ── Business logic methods (called by webhook handler) ───────────────

  /** Claim a ready issue: create workspace and set workspace_ready status. */
  async claimReadyIssue(
    issueNumber: number,
    issueTitle: string,
    issueBody: string,
    issueLabels: string[],
    issueAuthor: string | null,
    senderLogin: string,
  ): Promise<void> {
    // Check user allowlist
    if (senderLogin && !isAllowedUser(senderLogin)) {
      logger.info(
        `[auto-dev] claimReadyIssue: sender "${senderLogin}" is not authorized — ignoring issue #${issueNumber}`,
      );
      return;
    }

    // Check for existing non-terminal run for this issue
    const existingRun = listWorkflowRuns(this.workspaceRoot).find(
      (r) =>
        r.issueNumber === issueNumber &&
        ![
          "completed",
          "failed",
          "cancelled",
          "abandoned",
          "cleaned",
          "stale",
        ].includes(r.status),
    );
    if (existingRun) {
      logger.info(
        `[auto-dev] claimReadyIssue: issue #${issueNumber} already has active run ${existingRun.id} — ignoring`,
      );
      return;
    }

    // Respect concurrent run limit
    const maxConcurrent = this.config!.maxConcurrentRuns;
    if (this.activeRuns.size >= maxConcurrent) {
      logger.info(
        `[auto-dev] claimReadyIssue: concurrent limit (${maxConcurrent}) reached — queuing issue #${issueNumber}`,
      );
      upsertReadyIssueCandidate(this.workspaceRoot, {
        repoFullName: this.repoFullName,
        issueNumber,
        senderLogin,
        payloadJson: JSON.stringify({
          issueTitle,
          issueBody,
          issueLabels,
          issueAuthor,
        }),
      });
      return;
    }

    const { parseFrontmatter } = await import("@/shared/frontmatter-parser.js");
    const bodyFm = parseFrontmatter(issueBody);
    const agentDefinition =
      bodyFm?.agent && this.config!.agents[bodyFm.agent]
        ? bodyFm.agent
        : this.config!.defaultAgent;
    const agentModel =
      bodyFm?.model ??
      this.config!.agents[agentDefinition]?.defaultModel ??
      null;

    const result: import("@/shared/types.js").PollResult = {
      issueNumber,
      title: issueTitle,
      body: issueBody,
      labels: issueLabels,
      author: issueAuthor,
      agentDefinition,
      agentModel,
      agentEffort: bodyFm?.effort ?? null,
      maxDecisions: bodyFm?.maxDecisions ?? null,
      maxTurns: bodyFm?.maxTurns ?? null,
      permissionMode: bodyFm?.permissionMode ?? null,
      baseBranch: bodyFm?.baseBranch ?? "main",
    };

    await this.handleNewIssue(result);
  }

  /** Handle `@autodev ...` in a workspace_ready issue comment. */
  async handleIssueAutodevComment(
    issueNumber: number,
    commentId: number,
    commentBody: string,
    author: string,
    resourceVersion: string,
  ): Promise<void> {
    if (!isAllowedUser(author)) return;

    const handler = "issue_trigger";
    const commentIdStr = String(commentId);
    if (
      isEventProcessedV2(
        this.workspaceRoot,
        handler,
        commentIdStr,
        resourceVersion,
      )
    ) {
      return;
    }

    const run = listWorkflowRuns(this.workspaceRoot).find(
      (r) => r.issueNumber === issueNumber && r.status === "workspace_ready",
    );
    if (!run) {
      logger.info(
        `[auto-dev] handleIssueAutodevComment: no workspace_ready run for issue #${issueNumber}`,
      );
      return;
    }

    logger.info(
      `[auto-dev] Issue #${issueNumber} @autodev trigger from @${author}`,
    );

    try {
      addCommentReaction(this.repoFullName, commentId, "eyes");
    } catch {
      /* best-effort */
    }

    await this.handleIssueCommentTrigger(run, commentId, commentBody, author);

    await markEventProcessedV2(this.workspaceRoot, {
      handler,
      githubCommentId: commentIdStr,
      repoFullName: this.repoFullName,
      issueOrPrNumber: issueNumber,
      resourceVersion,
    });
  }

  /** Handle `@autodev ...` in a PR comment (re-trigger). */
  async handlePRAutodevComment(
    prNumber: number,
    commentId: number,
    commentBody: string,
    author: string,
    resourceVersion: string,
  ): Promise<void> {
    if (!isAllowedUser(author)) return;
    if (author === "auto-dev[bot]") return;

    const handler = "pr_trigger";
    const commentIdStr = String(commentId);
    if (
      isEventProcessedV2(
        this.workspaceRoot,
        handler,
        commentIdStr,
        resourceVersion,
      )
    ) {
      return;
    }

    const match = commentBody.match(/@autodev\b/i);
    if (!match) return;
    const instruction = commentBody
      .slice(match.index! + "@autodev".length)
      .trim();
    if (!instruction) return;

    const runs = this.workflowManager!.listAll();
    const run = runs.find((r) => r.prNumber === prNumber);
    if (!run) {
      logger.warn(`[auto-dev] No WorkflowRun found for PR #${prNumber}`);
      return;
    }

    logger.info(
      `[auto-dev] PR #${prNumber} trigger detected from @${author}: "${instruction.slice(0, 80)}"`,
    );

    await this.handlePRTrigger(run, commentBody, prNumber);

    await markEventProcessedV2(this.workspaceRoot, {
      handler,
      githubCommentId: commentIdStr,
      repoFullName: this.repoFullName,
      issueOrPrNumber: prNumber,
      resourceVersion,
    });
  }

  /** Handle `@dN <choice>` decision resolution in issue or PR comments. */
  async handleDecisionComment(
    issueOrPrNumber: number,
    commentId: number,
    commentBody: string,
    author: string,
    channel: "issue_comment" | "pr_comment",
    resourceVersion: string,
  ): Promise<void> {
    if (!isAllowedUser(author)) return;

    const handler =
      channel === "issue_comment"
        ? "issue_decision_resolution"
        : "pr_decision_resolution";
    const commentIdStr = String(commentId);

    if (
      isEventProcessedV2(
        this.workspaceRoot,
        handler,
        commentIdStr,
        resourceVersion,
      )
    ) {
      return;
    }

    // Find active run for this issue/PR number
    const allRuns = listWorkflowRuns(this.workspaceRoot).filter(
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
    const run = allRuns.find(
      (r) =>
        (channel === "issue_comment" && r.issueNumber === issueOrPrNumber) ||
        (channel === "pr_comment" && r.prNumber === issueOrPrNumber),
    );
    if (!run) return;

    const matches = [...commentBody.matchAll(/@(d\d+)\s+(\S+)/gi)];
    for (const [, rawAlias, choice] of matches) {
      const alias = rawAlias.toLowerCase();
      const pending = listDecisions(this.workspaceRoot).find(
        (d) =>
          d.workflowRunId === run.id &&
          d.alias === alias &&
          d.status === "pending",
      );
      if (pending) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await this.decisionManager!.resolve(
            pending.id,
            choice,
            author,
            channel,
          );
          logger.info(
            `[auto-dev] Resolved ${pending.id} (${alias}) via ${channel} by ${author} -> ${choice}`,
          );
        } catch (err) {
          logger.warn(
            `[auto-dev] Failed to resolve ${pending.id} (${alias}) via ${channel}: ${String(err)}`,
          );
        }
      }
    }

    await markEventProcessedV2(this.workspaceRoot, {
      handler,
      githubCommentId: commentIdStr,
      repoFullName: this.repoFullName,
      issueOrPrNumber,
      resourceVersion,
    });
  }

  /** Cleanup a run whose issue was closed. */
  async handleIssueClosed(issueNumber: number): Promise<void> {
    const run = listWorkflowRuns(this.workspaceRoot).find(
      (r) =>
        r.issueNumber === issueNumber &&
        (r.status === "workspace_ready" || r.status === "running"),
    );
    if (!run) return;

    logger.info(
      `[auto-dev] Issue #${issueNumber} closed — cleaning up workspace`,
    );
    await this.cleanupRun(run, "cancelled");
    await this.drainReadyIssueCandidates();
  }

  /** Cleanup a run whose PR was merged. */
  async handlePRMerged(prNumber: number): Promise<void> {
    const run = listWorkflowRuns(this.workspaceRoot).find(
      (r) => r.prNumber === prNumber,
    );
    if (!run) return;

    logger.info(
      `[auto-dev] PR #${prNumber} merged — cleaning up workspace for issue #${run.issueNumber}`,
    );
    await this.cleanupRun(run, "completed");
    await this.drainReadyIssueCandidates();
  }

  // ── Poll loops (REMOVED - replaced by webhook events) ────────────────

  // Note: pollLoop, startCommentPoller, startPRTriggerPoller,
  // startIssueCommentPoller, startLifecyclePoller have been removed.
  // Business logic is now driven by webhook events received in GithubWebhookHandler.

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
      const pushMeta =
        await this.workspaceManager!.getGitManager().commitAndPush(
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
          // Release concurrency slot and allow queued candidates to start
          void this.drainReadyIssueCandidates();
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
      // Release concurrency slot and allow queued candidates to start
      void this.drainReadyIssueCandidates();
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

  private async hydrateIssueContextIfMissing(
    run: WorkflowRun,
  ): Promise<WorkflowRun> {
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

  // ── Lifecycle poller (cleanup closed issues / merged PRs) ───────────

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
