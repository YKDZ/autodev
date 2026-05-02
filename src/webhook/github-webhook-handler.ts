import type { WebhookEvent } from "./github-webhook-types.js";
import {
    IssuesLabeledPayloadSchema,
    IssuesClosedPayloadSchema,
    IssueCommentPayloadSchema,
    PullRequestClosedPayloadSchema,
} from "./github-webhook-types.js";

import { logger } from "@/shared/logger.js";
import {
    getWebhookDelivery,
    upsertWebhookDelivery,
    updateWebhookDeliveryStatus,
} from "@/state-store/index.js";

// ── Business logic interface ──────────────────────────────────────────

/**
 * Interface for the orchestrator business logic methods that the
 * webhook handler calls. This decouples the handler from the full
 * Orchestrator class for easier testing.
 */
export interface WebhookHandlerContext {
    workspaceRoot: string;
    repoFullName: string;

    /** Claim a ready issue and create its workspace. */
    claimReadyIssue(
        issueNumber: number,
        issueTitle: string,
        issueBody: string,
        issueLabels: string[],
        issueAuthor: string | null,
        senderLogin: string,
    ): Promise<void>;

    /** Handle `@autodev ...` in a workspace_ready issue comment. */
    handleIssueAutodevComment(
        issueNumber: number,
        commentId: number,
        commentBody: string,
        author: string,
        resourceVersion: string,
    ): Promise<void>;

    /** Handle `@autodev ...` in a PR comment. */
    handlePRAutodevComment(
        prNumber: number,
        commentId: number,
        commentBody: string,
        author: string,
        resourceVersion: string,
    ): Promise<void>;

    /** Handle `@dN <choice>` decision resolution in issue or PR comments. */
    handleDecisionComment(
        issueOrPrNumber: number,
        commentId: number,
        commentBody: string,
        author: string,
        channel: "issue_comment" | "pr_comment",
        resourceVersion: string,
    ): Promise<void>;

    /** Cleanup a run whose issue was closed. */
    handleIssueClosed(issueNumber: number): Promise<void>;

    /** Cleanup a run whose PR was merged. */
    handlePRMerged(prNumber: number): Promise<void>;
}

// ── Handler ───────────────────────────────────────────────────────────

export class GithubWebhookHandler {
    private readonly ctx: WebhookHandlerContext;

    constructor(ctx: WebhookHandlerContext) {
        this.ctx = ctx;
    }

    async handle(event: WebhookEvent): Promise<void> {
        const { deliveryId, eventType, payload, receivedAt } = event;

        // Idempotency check: skip already-processed deliveries
        const existing = getWebhookDelivery(this.ctx.workspaceRoot, deliveryId);
        if (existing) {
            if (existing.status === "processed" || existing.status === "ignored") {
                logger.info(
                    `[webhook] Skipping already-${existing.status} delivery ${deliveryId}`,
                );
                return;
            }
            // queued/processing/failed: allow reprocessing (e.g. manual redelivery)
        }

        // Record delivery
        upsertWebhookDelivery(this.ctx.workspaceRoot, {
            deliveryId,
            event: eventType,
            action: this.extractAction(payload),
            repoFullName: this.extractRepo(payload) ?? this.ctx.repoFullName,
            status: "processing",
            receivedAt,
            payloadJson: JSON.stringify(payload),
        });

        try {
            const result = await this.dispatch(eventType, payload, deliveryId);
            updateWebhookDeliveryStatus(
                this.ctx.workspaceRoot,
                deliveryId,
                result,
            );
        } catch (err) {
            const message = String(err);
            logger.error(
                `[webhook] Handler error for ${eventType} delivery ${deliveryId}: ${message}`,
            );
            updateWebhookDeliveryStatus(
                this.ctx.workspaceRoot,
                deliveryId,
                "failed",
                message,
            );
        }
    }

    private async dispatch(
        eventType: string,
        payload: unknown,
        deliveryId: string,
    ): Promise<"processed" | "ignored"> {
        switch (eventType) {
            case "issues":
                return this.handleIssuesEvent(payload, deliveryId);
            case "issue_comment":
                return this.handleIssueCommentEvent(payload, deliveryId);
            case "pull_request":
                return this.handlePullRequestEvent(payload, deliveryId);
            default:
                logger.info(`[webhook] Ignoring unhandled event type: ${eventType}`);
                return "ignored";
        }
    }

    // ── issues event ─────────────────────────────────────────────────────

    private async handleIssuesEvent(
        payload: unknown,
        deliveryId: string,
    ): Promise<"processed" | "ignored"> {
        const action = this.extractAction(payload);

        if (action === "labeled") {
            const parsed = IssuesLabeledPayloadSchema.safeParse(payload);
            if (!parsed.success) {
                logger.warn(
                    `[webhook] issues:labeled parse error (${deliveryId}): ${parsed.error.message}`,
                );
                return "ignored";
            }
            await this.handleIssuesLabeled(parsed.data);
            return "processed";
        }

        if (action === "closed") {
            const parsed = IssuesClosedPayloadSchema.safeParse(payload);
            if (!parsed.success) {
                logger.warn(
                    `[webhook] issues:closed parse error (${deliveryId}): ${parsed.error.message}`,
                );
                return "ignored";
            }
            // Repo guard
            if (parsed.data.repository.full_name !== this.ctx.repoFullName) {
                logger.info(
                    `[webhook] issues:closed: repo mismatch (${parsed.data.repository.full_name} vs ${this.ctx.repoFullName}) — ignoring`,
                );
                return "ignored";
            }
            await this.ctx.handleIssueClosed(parsed.data.issue.number);
            return "processed";
        }

        return "ignored";
    }

    private async handleIssuesLabeled(
        data: import("./github-webhook-types.js").IssuesLabeledPayload,
    ): Promise<void> {
        const { issue, label, sender, repository } = data;

        // Only process if the added label is auto-dev:ready
        if (label?.name !== "auto-dev:ready") {
            logger.info(
                `[webhook] issues:labeled: label "${label?.name ?? "(unknown)"}" is not auto-dev:ready — ignoring`,
            );
            return;
        }

        // Repo guard
        if (repository.full_name !== this.ctx.repoFullName) {
            logger.info(
                `[webhook] issues:labeled: repo mismatch (${repository.full_name} vs ${this.ctx.repoFullName}) — ignoring`,
            );
            return;
        }

        // human-only check
        const labelNames = issue.labels.map((l) =>
            typeof l === "string" ? l : l.name,
        );
        if (labelNames.includes("human-only")) {
            logger.info(
                `[webhook] issues:labeled: issue #${issue.number} has human-only label — ignoring`,
            );
            return;
        }

        // Issue must be open
        if (issue.state !== "open") {
            logger.info(
                `[webhook] issues:labeled: issue #${issue.number} is not open (state: ${issue.state}) — ignoring`,
            );
            return;
        }

        const issueAuthor = issue.user?.login ?? issue.author?.login ?? null;

        await this.ctx.claimReadyIssue(
            issue.number,
            issue.title,
            issue.body ?? "",
            labelNames,
            issueAuthor,
            sender.login,
        );
    }

    // ── issue_comment event ───────────────────────────────────────────────

    private async handleIssueCommentEvent(
        payload: unknown,
        _deliveryId: string,
    ): Promise<"processed" | "ignored"> {
        const parsed = IssueCommentPayloadSchema.safeParse(payload);
        if (!parsed.success) {
            logger.warn(
                `[webhook] issue_comment parse error (${_deliveryId}): ${parsed.error.message}`,
            );
            return "ignored";
        }

        const { action, issue, comment, sender, repository } = parsed.data;

        if (action === "deleted") {
            return "ignored";
        }

        // Repo guard
        if (repository.full_name !== this.ctx.repoFullName) return "ignored";

        // Ignore bot comments
        if (comment.body.includes("<!-- auto-dev-bot -->")) return "ignored";

        const author = comment.user?.login ?? sender.login;
        const resourceVersion = comment.updated_at ?? comment.created_at ?? String(comment.id);
        const isPRComment = !!issue.pull_request;

        let handled = false;

        // Check for @dN decision resolution
        if (/@(d\d+)\s+\S+/i.test(comment.body)) {
            const channel: "issue_comment" | "pr_comment" = isPRComment
                ? "pr_comment"
                : "issue_comment";
            await this.ctx.handleDecisionComment(
                issue.number,
                comment.id,
                comment.body,
                author,
                channel,
                resourceVersion,
            );
            handled = true;
        }

        // Check for @autodev (separate from decision — both may appear in same comment)
        if (/@autodev\b/i.test(comment.body)) {
            if (isPRComment) {
                await this.ctx.handlePRAutodevComment(
                    issue.number,
                    comment.id,
                    comment.body,
                    author,
                    resourceVersion,
                );
            } else {
                await this.ctx.handleIssueAutodevComment(
                    issue.number,
                    comment.id,
                    comment.body,
                    author,
                    resourceVersion,
                );
            }
            handled = true;
        }

        return handled ? "processed" : "ignored";
    }

    // ── pull_request event ────────────────────────────────────────────────

    private async handlePullRequestEvent(
        payload: unknown,
        _deliveryId: string,
    ): Promise<"processed" | "ignored"> {
        const parsed = PullRequestClosedPayloadSchema.safeParse(payload);
        if (!parsed.success || parsed.data.action !== "closed") {
            return "ignored";
        }

        const { pull_request: pr, repository } = parsed.data;

        // Repo guard
        if (repository.full_name !== this.ctx.repoFullName) {
            logger.info(
                `[webhook] pull_request:closed: repo mismatch (${repository.full_name} vs ${this.ctx.repoFullName}) — ignoring`,
            );
            return "ignored";
        }

        // Only handle merged PRs
        if (!pr.merged) {
            logger.info(
                `[webhook] pull_request:closed: PR #${pr.number} not merged — ignoring`,
            );
            return "ignored";
        }

        await this.ctx.handlePRMerged(pr.number);
        return "processed";
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private extractAction(payload: unknown): string | null {
        if (
            payload !== null &&
            typeof payload === "object" &&
            "action" in payload
        ) {
            const p = payload as Record<string, unknown>;
            return typeof p.action === "string" ? p.action : null;
        }
        return null;
    }

    private extractRepo(payload: unknown): string | null {
        if (
            payload !== null &&
            typeof payload === "object" &&
            "repository" in payload
        ) {
            const p = payload as Record<string, unknown>;
            const repo = p.repository;
            if (
                repo !== null &&
                typeof repo === "object" &&
                "full_name" in (repo)
            ) {
                const r = repo as Record<string, unknown>;
                return typeof r.full_name === "string" ? r.full_name : null;
            }
        }
        return null;
    }
}
