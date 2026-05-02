import { z } from "zod";

// ── Shared sub-schemas ────────────────────────────────────────────────

const GithubUserSchema = z.object({
    login: z.string(),
    id: z.number().optional(),
});

const GithubLabelSchema = z.object({
    name: z.string(),
    color: z.string().optional(),
});

const GithubRepositorySchema = z.object({
    full_name: z.string(),
    name: z.string(),
    owner: GithubUserSchema,
});

const GithubIssueSchema = z.object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional().transform((v) => v ?? ""),
    state: z.string(),
    labels: z.array(z.union([z.string(), GithubLabelSchema])),
    author: GithubUserSchema.optional(),
    user: GithubUserSchema.optional(),
    pull_request: z
        .object({
            url: z.string().optional(),
        })
        .optional(),
});

const GithubCommentSchema = z.object({
    id: z.number(),
    body: z.string(),
    user: GithubUserSchema.optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
});

const GithubPullRequestSchema = z.object({
    number: z.number(),
    title: z.string().optional(),
    state: z.string(),
    merged: z.boolean().optional(),
    head: z
        .object({
            ref: z.string(),
        })
        .optional(),
    base: z
        .object({
            ref: z.string(),
        })
        .optional(),
});

// ── Event payload schemas ─────────────────────────────────────────────

export const IssuesLabeledPayloadSchema = z.object({
    action: z.literal("labeled"),
    issue: GithubIssueSchema,
    label: GithubLabelSchema.optional(),
    sender: GithubUserSchema,
    repository: GithubRepositorySchema,
});

export const IssuesClosedPayloadSchema = z.object({
    action: z.literal("closed"),
    issue: GithubIssueSchema,
    sender: GithubUserSchema,
    repository: GithubRepositorySchema,
});

export const IssueCommentPayloadSchema = z.object({
    action: z.enum(["created", "edited", "deleted"]),
    issue: GithubIssueSchema,
    comment: GithubCommentSchema,
    sender: GithubUserSchema,
    repository: GithubRepositorySchema,
});

export const PullRequestClosedPayloadSchema = z.object({
    action: z.literal("closed"),
    pull_request: GithubPullRequestSchema,
    sender: GithubUserSchema,
    repository: GithubRepositorySchema,
});

export const PingPayloadSchema = z.object({
    zen: z.string().optional(),
    hook_id: z.number().optional(),
    hook: z
        .object({
            id: z.number().optional(),
            type: z.string().optional(),
        })
        .optional(),
    repository: GithubRepositorySchema.optional(),
    sender: GithubUserSchema.optional(),
});

// ── Union type ────────────────────────────────────────────────────────

export type IssuesLabeledPayload = z.infer<typeof IssuesLabeledPayloadSchema>;
export type IssuesClosedPayload = z.infer<typeof IssuesClosedPayloadSchema>;
export type IssueCommentPayload = z.infer<typeof IssueCommentPayloadSchema>;
export type PullRequestClosedPayload = z.infer<
    typeof PullRequestClosedPayloadSchema
>;
export type PingPayload = z.infer<typeof PingPayloadSchema>;

export interface WebhookEvent {
    deliveryId: string;
    eventType: string;
    payload: unknown;
    receivedAt: string;
}
