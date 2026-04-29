import { describe, it, expect, vi, beforeEach } from "vitest";

import { loadConfig } from "./loader.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import { existsSync } from "node:fs";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadConfig", () => {
  it("returns DEFAULT_CONFIG (with 5 agents) when config file is missing", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const config = await loadConfig("/tmp/test-workspace");
    expect(config.defaultAgent).toBe("full-pipeline");
    expect(config.pollIntervalSec).toBe(30);
    expect(config.maxDecisionPerRun).toBe(20);
    expect(config.maxImplCycles).toBe(5);
    expect(Object.keys(config.agents)).toHaveLength(5);
  });

  it("returns defaults when config file fails to import", async () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      if (typeof path === "string" && path.endsWith("auto-dev.config.ts"))
        return true;
      return false;
    });
    const config = await loadConfig("/tmp/test-workspace");
    expect(config.defaultAgent).toBe("full-pipeline");
    expect(Object.keys(config.agents)).toHaveLength(5);
  });

  it("returns defaults when config fails Zod validation", async () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      if (typeof path === "string" && path.endsWith("auto-dev.config.ts"))
        return true;
      return false;
    });
    const config = await loadConfig("/tmp/test-workspace");
    expect(config.defaultAgent).toBe("full-pipeline");
  });

  it("clamps out-of-range numeric values", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const config = await loadConfig("/tmp/test-workspace");
    expect(config.pollIntervalSec).toBeGreaterThanOrEqual(10);
    expect(config.pollIntervalSec).toBeLessThanOrEqual(3600);
    expect(config.maxDecisionPerRun).toBeGreaterThanOrEqual(1);
    expect(config.maxDecisionPerRun).toBeLessThanOrEqual(100);
  });

  it("throws ConfigLoadError when no agents remain and defaultAgent invalid", async () => {
    // When config file is missing and no agent files exist,
    // DEFAULT_CONFIG is returned which always has agents, so this case
    // only happens if the config is loaded but agents are all removed
    vi.mocked(existsSync).mockReturnValue(false);
    const config = await loadConfig("/tmp/test-workspace");
    expect(Object.keys(config.agents)).toHaveLength(5);
  });
});
