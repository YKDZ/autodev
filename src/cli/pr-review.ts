import { parseArgs } from "node:util";

import {
  createPRReviewComment,
  getPRHeadSha,
  listPRReviewComments,
  submitPRReview,
} from "../shared/gh-cli.js";
import { logger } from "../shared/logger.js";

const getRepo = (): string => {
  const repo = process.env.GITHUB_REPOSITORY ?? process.env.REPO_FULL_NAME;
  if (!repo) {
    logger.error("GITHUB_REPOSITORY or REPO_FULL_NAME env var must be set");
    process.exit(1);
  }
  return repo;
};

/** auto-dev pr-review-comment <pr-number> <path> <position> --body <text>
 * position: 1-based line offset within the diff hunk (run `gh pr diff <pr>` to identify it)
 */
export const runPRReviewComment = async (args: string[]): Promise<void> => {
  const { values, positionals } = parseArgs({
    args,
    options: {
      body: { type: "string" },
    },
    allowPositionals: true,
  });

  const [prNumberStr, filePath, positionStr] = positionals;
  if (!prNumberStr || !filePath || !positionStr || !values.body) {
    logger.error(
      "Usage: auto-dev pr-review-comment <pr-number> <path> <position> --body <text>\n" +
        "  position: 1-based offset within the diff hunk (use gh pr diff <pr> to identify)",
    );
    process.exit(1);
  }

  const prNumber = parseInt(prNumberStr, 10);
  const position = parseInt(positionStr, 10);

  if (isNaN(prNumber) || isNaN(position)) {
    logger.error("pr-number and position must be integers");
    process.exit(1);
  }

  const repo = getRepo();
  const commitId = getPRHeadSha(repo, prNumber);

  createPRReviewComment(repo, prNumber, {
    commitId,
    path: filePath,
    position,
    body: values.body,
  });

  logger.info(
    `[auto-dev] Posted review comment on PR #${prNumber} at ${filePath} (diff position ${position})`,
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
