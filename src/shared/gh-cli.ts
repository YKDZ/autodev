import { execFileSync } from "node:child_process";

import { getAuthEnv } from "./github-app-auth.js";
import { logger } from "./logger.js";
import {
  GhIssueSchema,
  GhPRSchema,
  GhCommentSchema,
  type GhIssue,
  type GhPR,
  type GhComment,
} from "./schemas.js";

export type { GhIssue, GhPR, GhComment } from "./schemas.js";

/** Minimum milliseconds to wait after a rate-limit error before retrying. */
const RATE_LIMIT_BACKOFF_MS = 60_000;

/**
 * Detect if an error message indicates a GitHub API rate limit response.
 */
const isRateLimitError = (message: string): boolean =>
  /rate.?limit|429|api rate/i.test(message);

/**
 * Last time a rate-limit error was observed. Used to throttle subsequent calls.
 */
let rateLimitedUntil = 0;

const gh = (args: string[], opts?: { cwd?: string }): string => {
  const now = Date.now();
  if (now < rateLimitedUntil) {
    const waitSec = Math.ceil((rateLimitedUntil - now) / 1000);
    throw new Error(`gh CLI rate-limited — retry in ${waitSec}s (${args[0]})`);
  }

  try {
    const authEnv = getAuthEnv();
    return execFileSync("gh", args, {
      encoding: "utf-8",
      cwd: opts?.cwd,
      env: { ...process.env, ...authEnv },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isRateLimitError(message)) {
      rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      logger.warn(
        `[auto-dev] GitHub API rate limit hit — backing off for ${RATE_LIMIT_BACKOFF_MS / 1000}s`,
      );
    }
    throw new Error(`gh CLI error (${args[0]}): ${message}`);
  }
};

export const listIssues = (
  repo: string,
  label: string,
  limit = 25,
): GhIssue[] => {
  const output = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    label,
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,title,labels,body,author",
  ]);
  return GhIssueSchema.array().parse(JSON.parse(output));
};

export const getIssue = (repo: string, issueNumber: number): GhIssue => {
  const output = gh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "number,title,labels,body,author",
  ]);
  return GhIssueSchema.parse(JSON.parse(output));
};

export const createComment = (
  repo: string,
  issueNumber: number,
  body: string,
): void => {
  gh(["issue", "comment", String(issueNumber), "--repo", repo, "--body", body]);
};

export const updateIssueLabels = (
  repo: string,
  issueNumber: number,
  labels: string[],
): void => {
  gh([
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    repo,
    "--add-label",
    labels.join(","),
  ]);
};

export const removeIssueLabels = (
  repo: string,
  issueNumber: number,
  labels: string[],
): void => {
  gh([
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    repo,
    "--remove-label",
    labels.join(","),
  ]);
};

export const createPR = (
  repo: string,
  title: string,
  body: string,
  head: string,
  base = "main",
): { number: number; url: string } => {
  const output = gh([
    "pr",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
    "--head",
    head,
    "--base",
    base,
  ]);
  const match = output.match(/\/pull\/(\d+)/);
  return { number: match ? parseInt(match[1], 10) : 0, url: output };
};

export const mergePR = (
  repo: string,
  prNumber: number,
  method: "merge" | "squash" | "rebase" = "merge",
): void => {
  gh(["pr", "merge", String(prNumber), `--${method}`, "--repo", repo]);
};

export const listPRs = (
  repo: string,
  _state: "open" | "closed" | "merged" = "open",
): GhPR[] => {
  const output = gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    _state,
    "--json",
    "number,title,headRefName",
  ]);
  return GhPRSchema.array().parse(JSON.parse(output));
};

export const getPRStatus = (repo: string, prNumber: number): string => {
  return gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "state,mergeable,reviews",
  ]);
};

export const listIssueComments = (
  repo: string,
  issueNumber: number,
): GhComment[] => {
  const output = gh(["api", `repos/${repo}/issues/${issueNumber}/comments`]);
  return GhCommentSchema.array().parse(JSON.parse(output));
};

export const listPRComments = (repo: string, prNumber: number): GhComment[] => {
  const output = gh(["api", `repos/${repo}/issues/${prNumber}/comments`]);
  return GhCommentSchema.array().parse(JSON.parse(output));
};

/** Add a reaction to an issue comment (e.g. "eyes", "heart", "+1"). */
export const addCommentReaction = (
  repo: string,
  commentId: number,
  content: string,
): void => {
  gh([
    "api",
    `repos/${repo}/issues/comments/${commentId}/reactions`,
    "-X",
    "POST",
    "-f",
    `content=${content}`,
  ]);
};

/** Get the head commit SHA of a PR. */
export const getPRHeadSha = (repo: string, prNumber: number): string => {
  const output = gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "headRefOid",
  ]);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const parsed = JSON.parse(output) as { headRefOid: string };
  return parsed.headRefOid;
};

/** Create an inline review comment on a PR file line.
 * Uses the line-number API (line + side), which supports multi-line ranges and suggestion blocks.
 * For a suggestion, pass `suggestion` instead of `body` — it will be wrapped in ```suggestion\n...\n```.
 * For multi-line comments (e.g., replacing lines 5-8), set `startLine` to the first line.
 */
export const createPRReviewComment = (
  repo: string,
  prNumber: number,
  comment: {
    commitId: string;
    path: string;
    /** The last (or only) line number in the file to anchor this comment to (1-based). */
    line: number;
    /** For multi-line comments: the first line number. Omit for single-line. */
    startLine?: number;
    /** Which side of the diff: "LEFT" (old) or "RIGHT" (new/added). Defaults to "RIGHT". */
    side?: "LEFT" | "RIGHT";
    /** Comment body text. Mutually exclusive with `suggestion`. */
    body?: string;
    /** Suggested replacement code. Wrapped automatically in ```suggestion fences. Mutually exclusive with `body`. */
    suggestion?: string;
  },
): void => {
  const bodyText =
    comment.suggestion !== undefined
      ? "```suggestion\n" + comment.suggestion + "\n```"
      : (comment.body ?? "");

  const side = comment.side ?? "RIGHT";
  const args = [
    "api",
    `repos/${repo}/pulls/${prNumber}/comments`,
    "-X",
    "POST",
    "-f",
    `body=${bodyText}`,
    "-f",
    `commit_id=${comment.commitId}`,
    "-f",
    `path=${comment.path}`,
    "-F",
    `line=${comment.line}`,
    "-f",
    `side=${side}`,
  ];
  if (comment.startLine !== undefined) {
    args.push("-F", `start_line=${comment.startLine}`);
    args.push("-f", `start_side=${side}`);
  }
  gh(args);
};

export interface PRReviewComment {
  id: number;
  path: string;
  line: number;
  body: string;
  user: { login: string };
  created_at: string;
}

/** List review comments on a PR. */
export const listPRReviewComments = (
  repo: string,
  prNumber: number,
): PRReviewComment[] => {
  const output = gh(["api", `repos/${repo}/pulls/${prNumber}/comments`]);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(output) as PRReviewComment[];
};

/** Submit a PR review (COMMENT / APPROVE / REQUEST_CHANGES). */
export const submitPRReview = (
  repo: string,
  prNumber: number,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  body?: string,
): void => {
  const flagMap: Record<string, string> = {
    COMMENT: "--comment",
    APPROVE: "--approve",
    REQUEST_CHANGES: "--request-changes",
  };
  const eventFlag = flagMap[event] ?? "--comment";
  const args = ["pr", "review", String(prNumber), "--repo", repo, eventFlag];
  if (body) args.push("--body", body);
  gh(args);
};

/** Get the state of an issue ("open" or "closed"). */
export const getIssueState = (repo: string, issueNumber: number): string => {
  const output = gh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "state",
  ]);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const parsed = JSON.parse(output) as { state: string };
  return parsed.state;
};

/** Get the state and mergedAt of a PR. */
export const getPRState = (
  repo: string,
  prNumber: number,
): { state: string; mergedAt: string | null } => {
  const output = gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "state,mergedAt",
  ]);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(output) as { state: string; mergedAt: string | null };
};

/**
 * Query who added the "auto-dev:ready" label to an issue via the GitHub GraphQL API.
 * Returns the actor login, or null if not found or on error.
 */
export const getReadyLabelAdder = (
  repo: string,
  issueNumber: number,
): string | null => {
  const slashIdx = repo.indexOf("/");
  if (slashIdx === -1) return null;
  const owner = repo.slice(0, slashIdx);
  const repoName = repo.slice(slashIdx + 1);
  const query = [
    "query($owner: String!, $repo: String!, $issue_number: Int!) {",
    "  repository(owner: $owner, name: $repo) {",
    "    issue(number: $issue_number) {",
    "      timelineItems(first: 50, itemTypes: LABELED_EVENT) {",
    "        nodes {",
    "          ... on LabeledEvent {",
    "            actor { login }",
    "            label { name }",
    "          }",
    "        }",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");

  try {
    const output = gh([
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repoName}`,
      "-F",
      `issue_number=${issueNumber}`,
      "-f",
      `query=${query}`,
    ]);

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const result = JSON.parse(output) as {
      data?: {
        repository?: {
          issue?: {
            timelineItems?: {
              nodes?: Array<{
                actor?: { login: string };
                label?: { name: string };
              }>;
            };
          };
        };
      };
    };
    const nodes =
      result.data?.repository?.issue?.timelineItems?.nodes ?? [];
    for (const node of nodes) {
      if (node.label?.name === "auto-dev:ready" && node.actor?.login) {
        return node.actor.login;
      }
    }
    return null;
  } catch {
    return null;
  }
};

/** Create a PR with optional draft flag. */
export const createPRWithDraft = (
  repo: string,
  title: string,
  body: string,
  head: string,
  base = "main",
  draft = false,
): { number: number; url: string } => {
  const args = [
    "pr",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
    "--head",
    head,
    "--base",
    base,
  ];
  if (draft) args.push("--draft");
  const output = gh(args);
  const match = output.match(/\/pull\/(\d+)/);
  return { number: match ? parseInt(match[1], 10) : 0, url: output };
};
