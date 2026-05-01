#!/usr/bin/env node

import { runAudit } from "./cli/audit.js";
import { runCIStatus } from "./cli/ci-status.js";
import { runConfig } from "./cli/config.js";
import { runDecisions } from "./cli/decisions.js";
import { runHelpRequest } from "./cli/help-request.js";
import { runList } from "./cli/list.js";
import {
  runPRReviewComment,
  runPRReviewSubmit,
  runPRReviewList,
} from "./cli/pr-review.js";
import { runPublishSummary } from "./cli/publish-summary.js";
import { runReportPhase } from "./cli/report-phase.js";
import { runRequestDecision } from "./cli/request-decision.js";
import { runRequestDecisions } from "./cli/request-decisions.js";
import { runRequestValidation } from "./cli/request-validation.js";
import { runResolveDecision } from "./cli/resolve-decision.js";
import { runStart } from "./cli/start.js";
import { runStatus } from "./cli/status.js";
import { runStop } from "./cli/stop.js";
import { logger } from "./shared/logger.js";

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  start: runStart,
  stop: runStop,
  status: runStatus,
  "ci-status": runCIStatus,
  "help-request": runHelpRequest,
  "request-decision": runRequestDecision,
  "request-decisions": runRequestDecisions,
  "resolve-decision": runResolveDecision,
  "request-validation": runRequestValidation,
  "report-phase": runReportPhase,
  "publish-summary": runPublishSummary,
  audit: runAudit,
  list: runList,
  decisions: runDecisions,
  config: runConfig,
  "pr-review-comment": runPRReviewComment,
  "pr-review-submit": runPRReviewSubmit,
  "pr-review-list": runPRReviewList,
};

const main = async () => {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || !COMMANDS[subcommand]) {
    logger.error(`Usage: auto-dev <command> [args]`);
    logger.error(`Available commands: ${Object.keys(COMMANDS).join(", ")}`);
    process.exit(subcommand ? 1 : 0);
  }

  await COMMANDS[subcommand](args.slice(1));
};

main().catch((err: unknown) => {
  logger.error(String(err));
  process.exit(1);
});
