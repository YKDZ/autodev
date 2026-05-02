// oxlint-disable typescript/unbound-method -- vi.fn() mocks on plain object; this binding is irrelevant
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    ensureStateDirs,
    getWebhookDelivery,
    upsertWebhookDelivery,
    closeDb,
} from "@/state-store/index.js";

import { GithubWebhookHandler } from "./github-webhook-handler.js";
import type { WebhookHandlerContext } from "./github-webhook-handler.js";
import type { WebhookEvent } from "./github-webhook-types.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const REPO = "owner/repo";

function makeCtx(
    workspaceRoot: string,
    overrides: Partial<WebhookHandlerContext> = {},
): WebhookHandlerContext {
    return {
        workspaceRoot,
        repoFullName: REPO,
        claimReadyIssue: vi.fn(),
        handleIssueAutodevComment: vi.fn(),
        handlePRAutodevComment: vi.fn(),
        handleDecisionComment: vi.fn(),
        handleIssueClosed: vi.fn(),
        handlePRMerged: vi.fn(),
        ...overrides,
    };
}

function makeEvent(
    overrides: Partial<WebhookEvent> & { eventType: string },
): WebhookEvent {
    return {
        deliveryId: "delivery-" + Math.random().toString(36).slice(2),
        receivedAt: new Date().toISOString(),
        payload: {},
        ...overrides,
    };
}

function issuesLabeledPayload(
    issueNumber: number,
    labelName: string,
    issueState = "open",
    extraLabels: string[] = [],
) {
    return {
        action: "labeled",
        label: { name: labelName },
        issue: {
            number: issueNumber,
            title: "Test issue",
            body: "issue body",
            state: issueState,
            user: { login: "author-user" },
            labels: [
                { name: labelName },
                ...extraLabels.map((n) => ({ name: n })),
            ],
        },
        sender: { login: "sender-user" },
        repository: { full_name: REPO, name: "repo", owner: { login: "owner" } },
    };
}

function issueCommentPayload(opts: {
    commentBody: string;
    commentId?: number;
    issueNumber?: number;
    action?: string;
    updatedAt?: string;
    isPR?: boolean;
}) {
    return {
        action: opts.action ?? "created",
        issue: {
            number: opts.issueNumber ?? 42,
            title: "Test issue",
            state: "open",
            labels: [],
            ...(opts.isPR ? { pull_request: { url: "https://example.com" } } : {}),
        },
        comment: {
            id: opts.commentId ?? 1001,
            body: opts.commentBody,
            user: { login: "commenter" },
            created_at: "2024-01-01T00:00:00Z",
            updated_at: opts.updatedAt ?? "2024-01-01T00:00:00Z",
        },
        sender: { login: "commenter" },
        repository: { full_name: REPO, name: "repo", owner: { login: "owner" } },
    };
}

function prClosedPayload(prNumber: number, merged: boolean) {
    return {
        action: "closed",
        pull_request: {
            number: prNumber,
            title: "Test PR",
            state: "closed",
            merged,
            head: { ref: "auto-dev/issue-1" },
        },
        sender: { login: "owner" },
        repository: { full_name: REPO, name: "repo", owner: { login: "owner" } },
    };
}

// ── test fixtures ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "auto-dev-handler-test-"));
    await ensureStateDirs(tmpDir);
});

afterEach(async () => {
    closeDb();
    await rm(tmpDir, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GithubWebhookHandler", () => {
    describe("delivery idempotency", () => {
        it("skips already-processed delivery", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);
            const deliveryId = "idempotent-1";

            // Pre-seed the delivery as processed
            upsertWebhookDelivery(tmpDir, {
                deliveryId,
                event: "issues",
                action: "labeled",
                repoFullName: REPO,
                status: "processed",
                receivedAt: new Date().toISOString(),
                payloadJson: "{}",
            });

            const event = makeEvent({
                deliveryId,
                eventType: "issues",
                payload: issuesLabeledPayload(1, "auto-dev:ready"),
            });

            await handler.handle(event);

            expect(ctx.claimReadyIssue).not.toHaveBeenCalled();
        });

        it("skips already-ignored delivery", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);
            const deliveryId = "idempotent-2";

            upsertWebhookDelivery(tmpDir, {
                deliveryId,
                event: "issues",
                action: "opened",
                repoFullName: REPO,
                status: "ignored",
                receivedAt: new Date().toISOString(),
                payloadJson: "{}",
            });

            const event = makeEvent({ deliveryId, eventType: "issues", payload: {} });
            await handler.handle(event);

            expect(ctx.claimReadyIssue).not.toHaveBeenCalled();
        });

        it("reprocesses a failed delivery", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);
            const deliveryId = "idempotent-failed";

            upsertWebhookDelivery(tmpDir, {
                deliveryId,
                event: "issues",
                action: "labeled",
                repoFullName: REPO,
                status: "failed",
                receivedAt: new Date().toISOString(),
                payloadJson: "{}",
            });

            const event = makeEvent({
                deliveryId,
                eventType: "issues",
                payload: issuesLabeledPayload(5, "auto-dev:ready"),
            });

            await handler.handle(event);

            expect(ctx.claimReadyIssue).toHaveBeenCalledOnce();
        });
    });

    describe("issues:labeled", () => {
        it("calls claimReadyIssue for auto-dev:ready label on open issue", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issues",
                payload: issuesLabeledPayload(10, "auto-dev:ready"),
            });

            await handler.handle(event);

            expect(ctx.claimReadyIssue).toHaveBeenCalledOnce();
            expect(ctx.claimReadyIssue).toHaveBeenCalledWith(
                10,
                "Test issue",
                "issue body",
                expect.arrayContaining(["auto-dev:ready"]),
                "author-user",
                "sender-user",
            );
        });

        it("ignores non-auto-dev:ready label", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issues",
                payload: issuesLabeledPayload(11, "bug"),
            });

            await handler.handle(event);

            expect(ctx.claimReadyIssue).not.toHaveBeenCalled();
        });

        it("ignores issue with human-only label", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issues",
                payload: issuesLabeledPayload(12, "auto-dev:ready", "open", [
                    "human-only",
                ]),
            });

            await handler.handle(event);

            expect(ctx.claimReadyIssue).not.toHaveBeenCalled();
        });

        it("ignores closed issue", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issues",
                payload: issuesLabeledPayload(13, "auto-dev:ready", "closed"),
            });

            await handler.handle(event);

            expect(ctx.claimReadyIssue).not.toHaveBeenCalled();
        });

        it("ignores repo mismatch", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const payload = {
                ...issuesLabeledPayload(14, "auto-dev:ready"),
                repository: { full_name: "other/repo", name: "repo", owner: { login: "other" } },
            };

            const event = makeEvent({ eventType: "issues", payload });
            await handler.handle(event);

            expect(ctx.claimReadyIssue).not.toHaveBeenCalled();
        });
    });

    describe("issues:closed", () => {
        it("calls handleIssueClosed for issues:closed event", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issues",
                payload: {
                    action: "closed",
                    issue: {
                        number: 20,
                        title: "Test",
                        body: "",
                        state: "closed",
                        labels: [],
                    },
                    sender: { login: "owner" },
                    repository: { full_name: REPO, name: "repo", owner: { login: "owner" } },
                },
            });

            await handler.handle(event);

            expect(ctx.handleIssueClosed).toHaveBeenCalledWith(20);
        });
    });

    describe("pull_request:closed", () => {
        it("calls handlePRMerged when PR is merged", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "pull_request",
                payload: prClosedPayload(99, true),
            });

            await handler.handle(event);

            expect(ctx.handlePRMerged).toHaveBeenCalledWith(99);
        });

        it("does not call handlePRMerged when PR is closed without merge", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "pull_request",
                payload: prClosedPayload(100, false),
            });

            await handler.handle(event);

            expect(ctx.handlePRMerged).not.toHaveBeenCalled();
        });
    });

    describe("issue_comment routing", () => {
        it("routes @autodev comment to handleIssueAutodevComment", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issue_comment",
                payload: issueCommentPayload({
                    commentBody: "@autodev please fix the bug",
                    issueNumber: 42,
                }),
            });

            await handler.handle(event);

            expect(ctx.handleIssueAutodevComment).toHaveBeenCalledOnce();
            expect(ctx.handleDecisionComment).not.toHaveBeenCalled();
        });

        it("routes @autodev on PR comment to handlePRAutodevComment", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issue_comment",
                payload: issueCommentPayload({
                    commentBody: "@autodev retrigger this",
                    issueNumber: 77,
                    isPR: true,
                }),
            });

            await handler.handle(event);

            expect(ctx.handlePRAutodevComment).toHaveBeenCalledOnce();
            expect(ctx.handleIssueAutodevComment).not.toHaveBeenCalled();
        });

        it("routes @d1 yes to handleDecisionComment", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issue_comment",
                payload: issueCommentPayload({
                    commentBody: "@d1 yes",
                    issueNumber: 55,
                }),
            });

            await handler.handle(event);

            expect(ctx.handleDecisionComment).toHaveBeenCalledOnce();
            expect(ctx.handleIssueAutodevComment).not.toHaveBeenCalled();
        });

        it("routes @d2 no on PR comment to handleDecisionComment with pr_comment channel", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issue_comment",
                payload: issueCommentPayload({
                    commentBody: "@d2 no",
                    isPR: true,
                }),
            });

            await handler.handle(event);

            expect(ctx.handleDecisionComment).toHaveBeenCalledWith(
                expect.any(Number),
                expect.any(Number),
                "@d2 no",
                "commenter",
                "pr_comment",
                expect.any(String),
            );
        });

        it("ignores bot comment (<!-- auto-dev-bot -->)", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issue_comment",
                payload: issueCommentPayload({
                    commentBody: "<!-- auto-dev-bot -->\n@autodev something",
                }),
            });

            await handler.handle(event);

            expect(ctx.handleIssueAutodevComment).not.toHaveBeenCalled();
            expect(ctx.handleDecisionComment).not.toHaveBeenCalled();
        });

        it("ignores deleted action", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issue_comment",
                payload: issueCommentPayload({
                    commentBody: "@autodev something",
                    action: "deleted",
                }),
            });

            await handler.handle(event);

            expect(ctx.handleIssueAutodevComment).not.toHaveBeenCalled();
        });

        it("ignores wrong repo", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const payload = {
                ...issueCommentPayload({ commentBody: "@autodev something" }),
                repository: { full_name: "other/repo", name: "repo", owner: { login: "other" } },
            };

            const event = makeEvent({ eventType: "issue_comment", payload });
            await handler.handle(event);

            expect(ctx.handleIssueAutodevComment).not.toHaveBeenCalled();
        });
    });

    describe("delivery status tracking", () => {
        it("marks delivery as processed on success", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const deliveryId = "tracking-success";
            const event = makeEvent({
                deliveryId,
                eventType: "issues",
                payload: issuesLabeledPayload(30, "auto-dev:ready"),
            });

            await handler.handle(event);

            const record = getWebhookDelivery(tmpDir, deliveryId);
            expect(record?.status).toBe("processed");
        });

        it("marks delivery as failed on error", async () => {
            const ctx = makeCtx(tmpDir, {
                claimReadyIssue: vi.fn().mockRejectedValue(new Error("boom")),
            });
            const handler = new GithubWebhookHandler(ctx);

            const deliveryId = "tracking-fail";
            const event = makeEvent({
                deliveryId,
                eventType: "issues",
                payload: issuesLabeledPayload(31, "auto-dev:ready"),
            });

            await handler.handle(event);

            const record = getWebhookDelivery(tmpDir, deliveryId);
            expect(record?.status).toBe("failed");
            expect(record?.lastError).toContain("boom");
        });

        it("marks delivery as ignored for unhandled event type", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const deliveryId = "tracking-ignored";
            const event = makeEvent({
                deliveryId,
                eventType: "push",
                payload: {},
            });

            await handler.handle(event);

            const record = getWebhookDelivery(tmpDir, deliveryId);
            expect(record?.status).toBe("ignored");
        });

        it("marks delivery as ignored (not processed) for issues unrecognised action", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const deliveryId = "tracking-issues-unrecognised";
            const event = makeEvent({
                deliveryId,
                eventType: "issues",
                payload: {
                    action: "reopened",
                    issue: { number: 1, title: "x", body: "", state: "open", labels: [] },
                    sender: { login: "u" },
                    repository: { full_name: REPO, name: "repo", owner: { login: "owner" } },
                },
            });

            await handler.handle(event);

            const record = getWebhookDelivery(tmpDir, deliveryId);
            expect(record?.status).toBe("ignored");
        });

        it("marks delivery as ignored for unmerged PR closed", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const deliveryId = "tracking-unmerged-pr";
            const event = makeEvent({
                deliveryId,
                eventType: "pull_request",
                payload: prClosedPayload(200, false),
            });

            await handler.handle(event);

            const record = getWebhookDelivery(tmpDir, deliveryId);
            expect(record?.status).toBe("ignored");
        });

        it("marks delivery as ignored for deleted issue_comment", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const deliveryId = "tracking-deleted-comment";
            const event = makeEvent({
                deliveryId,
                eventType: "issue_comment",
                payload: issueCommentPayload({ commentBody: "@autodev hi", action: "deleted" }),
            });

            await handler.handle(event);

            const record = getWebhookDelivery(tmpDir, deliveryId);
            expect(record?.status).toBe("ignored");
        });
    });

    describe("repo guard", () => {
        it("does not call handleIssueClosed for issues:closed from wrong repo", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issues",
                payload: {
                    action: "closed",
                    issue: { number: 50, title: "x", body: "", state: "closed", labels: [] },
                    sender: { login: "u" },
                    repository: { full_name: "other/repo", name: "repo", owner: { login: "other" } },
                },
            });

            await handler.handle(event);

            expect(ctx.handleIssueClosed).not.toHaveBeenCalled();
            const record = getWebhookDelivery(tmpDir, event.deliveryId);
            expect(record?.status).toBe("ignored");
        });

        it("does not call handlePRMerged for pull_request:closed from wrong repo", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const payload = {
                ...prClosedPayload(300, true),
                repository: { full_name: "other/repo", name: "repo", owner: { login: "other" } },
            };

            const event = makeEvent({ eventType: "pull_request", payload });
            await handler.handle(event);

            expect(ctx.handlePRMerged).not.toHaveBeenCalled();
            const record = getWebhookDelivery(tmpDir, event.deliveryId);
            expect(record?.status).toBe("ignored");
        });
    });

    describe("mixed comment (@dN and @autodev in same body)", () => {
        it("calls both handleDecisionComment and handleIssueAutodevComment", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issue_comment",
                payload: issueCommentPayload({
                    commentBody: "@d1 yes\n@autodev create-pr",
                    issueNumber: 88,
                }),
            });

            await handler.handle(event);

            expect(ctx.handleDecisionComment).toHaveBeenCalledOnce();
            expect(ctx.handleIssueAutodevComment).toHaveBeenCalledOnce();
        });

        it("calls both handleDecisionComment and handlePRAutodevComment for PR comments", async () => {
            const ctx = makeCtx(tmpDir);
            const handler = new GithubWebhookHandler(ctx);

            const event = makeEvent({
                eventType: "issue_comment",
                payload: issueCommentPayload({
                    commentBody: "@d2 no\n@autodev review",
                    issueNumber: 89,
                    isPR: true,
                }),
            });

            await handler.handle(event);

            expect(ctx.handleDecisionComment).toHaveBeenCalledOnce();
            expect(ctx.handlePRAutodevComment).toHaveBeenCalledOnce();
        });
    });
});
