import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

import { loadConfig } from "./loader.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

import { existsSync } from "node:fs";

const DEFAULT_ENV = {
  AUTO_DEV_DEFAULT_AGENT: process.env["AUTO_DEV_DEFAULT_AGENT"],
  AUTO_DEV_POLL_INTERVAL_SEC: process.env["AUTO_DEV_POLL_INTERVAL_SEC"],
  AUTO_DEV_MAX_DECISION_PER_RUN: process.env["AUTO_DEV_MAX_DECISION_PER_RUN"],
  AUTO_DEV_MAX_IMPL_CYCLES: process.env["AUTO_DEV_MAX_IMPL_CYCLES"],
  AUTO_DEV_AGENTS: process.env["AUTO_DEV_AGENTS"],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Restore env vars to clean state
  process.env["AUTO_DEV_DEFAULT_AGENT"] = "";
  process.env["AUTO_DEV_POLL_INTERVAL_SEC"] = "";
  process.env["AUTO_DEV_MAX_DECISION_PER_RUN"] = "";
  process.env["AUTO_DEV_MAX_IMPL_CYCLES"] = "";
  process.env["AUTO_DEV_AGENTS"] = "";
});

afterAll(() => {
  // Restore original env
  for (const [key, val] of Object.entries(DEFAULT_ENV)) {
    if (val !== undefined) {
      process.env[key] = val;
    } else {
      delete process.env[key];
    }
  }
});

describe("loadConfig", () => {
  it("returns DEFAULT_CONFIG (with 5 agents) when no env vars are set", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const config = await loadConfig("/tmp/test-workspace");
    expect(config.defaultAgent).toBe("full-pipeline");
    expect(config.pollIntervalSec).toBe(30);
    expect(config.maxDecisionPerRun).toBe(20);
    expect(config.maxImplCycles).toBe(5);
    expect(Object.keys(config.agents)).toHaveLength(5);
  });

  it("overrides scalar values from env vars", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    process.env["AUTO_DEV_DEFAULT_AGENT"] = "impl-only";
    process.env["AUTO_DEV_POLL_INTERVAL_SEC"] = "10";
    process.env["AUTO_DEV_MAX_DECISION_PER_RUN"] = "5";
    process.env["AUTO_DEV_MAX_IMPL_CYCLES"] = "2";

    const config = await loadConfig("/tmp/test-workspace");
    expect(config.defaultAgent).toBe("impl-only");
    expect(config.pollIntervalSec).toBe(10);
    expect(config.maxDecisionPerRun).toBe(5);
    expect(config.maxImplCycles).toBe(2);
  });

  it("parses AUTO_DEV_AGENTS JSON and overrides default agents", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    process.env["AUTO_DEV_AGENTS"] = JSON.stringify({
      "impl-only": {
        definition: "impl.md",
        description: "Direct implementation",
        defaultModel: "sonnet",
      },
    });

    const config = await loadConfig("/tmp/test-workspace");
    expect(Object.keys(config.agents)).toHaveLength(1);
    expect(config.agents["impl-only"].definition).toBe("impl.md");
    expect(config.agents["impl-only"].defaultModel).toBe("sonnet");
  });

  it("clamps out-of-range numeric values", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    process.env["AUTO_DEV_POLL_INTERVAL_SEC"] = "1";
    process.env["AUTO_DEV_MAX_DECISION_PER_RUN"] = "200";

    const config = await loadConfig("/tmp/test-workspace");
    expect(config.pollIntervalSec).toBe(10);
    expect(config.maxDecisionPerRun).toBe(100);
  });

  it("removes agents whose definition files are missing", async () => {
    // All agent definition files missing
    vi.mocked(existsSync).mockReturnValue(false);

    await expect(loadConfig("/tmp/test-workspace")).rejects.toThrow(
      "No valid agent definitions found",
    );
  });

  it("falls back when defaultAgent is not in validated agents", async () => {
    // Only impl-only definition exists, full-pipeline (default) missing
    vi.mocked(existsSync).mockImplementation(
      (path: unknown) => typeof path === "string" && path.includes("impl"),
    );
    process.env["AUTO_DEV_DEFAULT_AGENT"] = "full-pipeline";

    const config = await loadConfig("/tmp/test-workspace");
    // Falls back to the first available agent (impl-only from defaults)
    expect(config.defaultAgent).toBe("impl-only");
    expect(Object.keys(config.agents)).toContain("impl-only");
  });
});
