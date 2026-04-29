// Hello from autodev
#!/usr/bin/env node

// hello auto-dev

import { logger } from "./shared/logger.js";
import { runAudit } from "./cli/audit.js";
import { runConfig } from "./cli/config.js";
import { runDecisions } from "./cli/decisions.js";
import { runHelpRequest } from "./cli/help-request.js";
import { runList } from "./cli/list.js";
import { runPublishSummary } from "./cli/publish-summary.js";
import { runReportPhase } from "./cli/report-phase.js";
import { runRequestDecision } from "./cli/request-decision.js";
import { runRequestDecisions } from "./cli/request-decisions.js";
import { runRequestValidation } from "./cli/request-validation.js";
import { runResolveDecision } from "./cli/resolve-decision.js";
import { runStart } from "./cli/start.js";
import { runStatus } from "./cli/status.js";
import { runStop } from "./cli/stop.js";

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  start: runStart,
  stop: runStop,
  status: runStatus,
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
