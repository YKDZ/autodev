import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { AutoDevConfig, AgentRegistration } from "./types.js";

import { ConfigLoadError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { DEFAULT_CONFIG } from "./types.js";

/**
 * Load auto-dev configuration from environment variables.
 */
export const loadConfig = async (
  workspaceRoot: string,
): Promise<AutoDevConfig> => {
  const config: AutoDevConfig = {
    agents: { ...DEFAULT_CONFIG.agents },
    defaultAgent: DEFAULT_CONFIG.defaultAgent,
    pollIntervalSec: DEFAULT_CONFIG.pollIntervalSec,
    maxDecisionPerRun: DEFAULT_CONFIG.maxDecisionPerRun,
    maxImplCycles: DEFAULT_CONFIG.maxImplCycles,
  };

  // Override from environment variables
  if (process.env["AUTO_DEV_DEFAULT_AGENT"]) {
    config.defaultAgent = process.env["AUTO_DEV_DEFAULT_AGENT"];
  }

  if (process.env["AUTO_DEV_POLL_INTERVAL_SEC"]) {
    const parsed = parseInt(process.env["AUTO_DEV_POLL_INTERVAL_SEC"], 10);
    if (!Number.isNaN(parsed)) config.pollIntervalSec = parsed;
  }

  if (process.env["AUTO_DEV_MAX_DECISION_PER_RUN"]) {
    const parsed = parseInt(process.env["AUTO_DEV_MAX_DECISION_PER_RUN"], 10);
    if (!Number.isNaN(parsed)) config.maxDecisionPerRun = parsed;
  }

  if (process.env["AUTO_DEV_MAX_IMPL_CYCLES"]) {
    const parsed = parseInt(process.env["AUTO_DEV_MAX_IMPL_CYCLES"], 10);
    if (!Number.isNaN(parsed)) config.maxImplCycles = parsed;
  }

  if (process.env["AUTO_DEV_AGENTS"]) {
    try {
      const parsed: unknown = JSON.parse(process.env["AUTO_DEV_AGENTS"]);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const agents: Record<string, AgentRegistration> = {};
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val !== "object" || val === null) continue;
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const { definition, description, defaultModel } = val as Record<
            string,
            unknown
          >;
          if (
            typeof definition === "string" &&
            typeof description === "string" &&
            typeof defaultModel === "string"
          ) {
            agents[key] = { definition, description, defaultModel };
          }
        }
        if (Object.keys(agents).length > 0) {
          config.agents = agents;
        }
      }
    } catch (err) {
      logger.warn(
        `[auto-dev] Failed to parse AUTO_DEV_AGENTS JSON: ${String(err)}. Using defaults.`,
      );
    }
  }

  // Validate agent definition files exist
  const agentsDir = process.env["AUTO_DEV_AGENTS_DIR"]
    ? resolve(workspaceRoot, process.env["AUTO_DEV_AGENTS_DIR"])
    : resolve(workspaceRoot, ".claude/agents");
  const validatedAgents: Record<string, AgentRegistration> = {};

  for (const [name, reg] of Object.entries(config.agents)) {
    const defPath = resolve(agentsDir, reg.definition);
    if (existsSync(defPath)) {
      validatedAgents[name] = reg;
    } else {
      logger.warn(
        `[auto-dev] Agent definition file not found for "${name}": ${defPath}. Removing from registry.`,
      );
    }
  }

  config.agents = validatedAgents;

  // Validate defaultAgent exists
  const agentNames = Object.keys(validatedAgents);
  if (!validatedAgents[config.defaultAgent]) {
    const fallback = agentNames[0];
    if (fallback) {
      logger.warn(
        `[auto-dev] defaultAgent "${config.defaultAgent}" not found, falling back to "${fallback}".`,
      );
      config.defaultAgent = fallback;
    } else {
      throw new ConfigLoadError(
        "No valid agent definitions found and no default available.",
      );
    }
  }

  // Clamp numeric values
  config.pollIntervalSec = Math.max(10, Math.min(3600, config.pollIntervalSec));
  config.maxDecisionPerRun = Math.max(
    1,
    Math.min(100, config.maxDecisionPerRun),
  );
  config.maxImplCycles = Math.max(1, Math.min(50, config.maxImplCycles));

  return config;
};
