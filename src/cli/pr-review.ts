import { parseArgs } from "node:util";

import {
  createPRReviewComment,
  getPRHeadSha,
  listPRReviewComments,
  submitPRReview,
} from "@/shared/gh-cli.js";
import { logger } from "@/shared/logger.js";

const getRepo = (): string => {
  const repo = process.env.GITHUB_REPOSITORY ?? process.env.REPO_FULL_NAME;
  if (!repo) {
    logger.error("GITHUB_REPOSITORY or REPO_FULL_NAME env var must be set");
    process.exit(1);
  }
  return repo;
};

/**
 * auto-dev pr-review-comment <pr-number> <path> <line> [--start-line <n>] [--side LEFT|RIGHT]
 *                             (--body <text> | --suggest <new-code>)
 *
 * --body      Freeform comment text.
 * --suggest   Suggested replacement code; automatically wrapped in ```suggestion fences.
 *             Users can click "Apply suggestion" in the GitHub UI to accept the change.
 * --start-line  For multi-line comments/suggestions: first line of the range.
 * --side      Which diff side to anchor to (RIGHT = new code, LEFT = old code). Default: RIGHT.
 */
export const runPRReviewComment = async (args: string[]): Promise<void> => {
  const { values, positionals } = parseArgs({
    args,
    options: {
      body: { type: "string" },
      suggest: { type: "string" },
      "start-line": { type: "string" },
      side: { type: "string" },
    },
    allowPositionals: true,
  });

  const [prNumberStr, filePath, lineStr] = positionals;
  if (
    !prNumberStr ||
    !filePath ||
    !lineStr ||
    (!values.body && !values.suggest)
  ) {
    logger.error(
      "Usage: auto-dev pr-review-comment <pr-number> <path> <line> (--body <text> | --suggest <new-code>)\n" +
        "  [--start-line <n>] [--side LEFT|RIGHT]\n" +
        "  --suggest wraps <new-code> in GitHub suggestion fences (Apply suggestion button in UI)",
    );
    process.exit(1);
  }

  const prNumber = parseInt(prNumberStr, 10);
  const line = parseInt(lineStr, 10);
  const startLine = values["start-line"]
    ? parseInt(values["start-line"], 10)
    : undefined;
  const sideRaw = values.side;
  const side: "LEFT" | "RIGHT" = sideRaw === "LEFT" ? "LEFT" : "RIGHT";

  if (isNaN(prNumber) || isNaN(line)) {
    logger.error("pr-number and line must be integers");
    process.exit(1);
  }

  const repo = getRepo();
  const commitId = getPRHeadSha(repo, prNumber);

  createPRReviewComment(repo, prNumber, {
    commitId,
    path: filePath,
    line,
    startLine,
    side,
    body: values.suggest !== undefined ? undefined : values.body,
    suggestion: values.suggest,
  });

  const mode = values.suggest !== undefined ? "suggestion" : "comment";
  const range = startLine !== undefined ? `${startLine}-${line}` : String(line);
  logger.info(
    `[auto-dev] Posted review ${mode} on PR #${prNumber} at ${filePath}:${range}`,
  );
};

/** auto-dev pr-review-submit <pr-number> [--approve|--comment|--request-changes] [--body <text>] */
export const runPRReviewSubmit = async (args: string[]): Promise<void> => {
  const { values, positionals } = parseArgs({
    args,
    options: {
      approve: { type: "boolean", default: false },
      comment: { type: "boolean", default: false },
      "request-changes": { type: "boolean", default: false },
      body: { type: "string" },
    },
    allowPositionals: true,
  });

  const [prNumberStr] = positionals;
  if (!prNumberStr) {
    logger.error(
      "Usage: auto-dev pr-review-submit <pr-number> [--approve|--comment|--request-changes] [--body <text>]",
    );
    process.exit(1);
  }

  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber)) {
    logger.error("pr-number must be an integer");
    process.exit(1);
  }

  let event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" = "COMMENT";
  if (values.approve) event = "APPROVE";
  else if (values["request-changes"]) event = "REQUEST_CHANGES";

  const repo = getRepo();
  submitPRReview(repo, prNumber, event, values.body);

  logger.info(`[auto-dev] Submitted PR #${prNumber} review (${event})`);
};

/** auto-dev pr-review-list <pr-number> */
export const runPRReviewList = async (args: string[]): Promise<void> => {
  const { positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
  });

  const [prNumberStr] = positionals;
  if (!prNumberStr) {
    logger.error("Usage: auto-dev pr-review-list <pr-number>");
    process.exit(1);
  }

  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber)) {
    logger.error("pr-number must be an integer");
    process.exit(1);
  }

  const repo = getRepo();
  const comments = listPRReviewComments(repo, prNumber);

  if (comments.length === 0) {
    logger.info("No review comments found.");
    return;
  }

  for (const c of comments) {
    logger.info(
      `[#${c.id}] ${c.path}:${c.line} by @${c.user.login} (${c.created_at})\n  ${c.body.slice(0, 200)}`,
    );
  }
};
