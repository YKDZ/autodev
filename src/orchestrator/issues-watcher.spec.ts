import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { DEFAULT_CONFIG } from "../config/types.js";
import { IssueWatcher } from "./issues-watcher.js";

vi.mock("../shared/gh-cli.js", () => ({
  listIssues: vi.fn(),
  getReadyLabelAdder: vi.fn(),
}));

import { listIssues, getReadyLabelAdder } from "../shared/gh-cli.js";

describe("IssueWatcher", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns empty array when gh CLI errors", () => {
    vi.stubEnv("AUTO_DEV_ALLOWED_USERS", "testuser");
    vi.mocked(listIssues).mockImplementation(() => {
      throw new Error("Network error");
    });
    vi.mocked(getReadyLabelAdder).mockReturnValue(null);

    const watcher = new IssueWatcher();
    const results = watcher.poll("owner/repo", DEFAULT_CONFIG, "/tmp/test");
    expect(results).toEqual([]);
  });

  it("filters out human-only issues", () => {
    vi.stubEnv("AUTO_DEV_ALLOWED_USERS", "allowed-user");
    vi.mocked(listIssues).mockReturnValue([
      {
        number: 1,
        title: "Issue 1",
        labels: [{ name: "auto-dev:ready" }, { name: "human-only" }],
        body: "body",
        author: { login: "allowed-user" },
      },
    ]);
    vi.mocked(getReadyLabelAdder).mockReturnValue("allowed-user");

    const watcher = new IssueWatcher();
    const results = watcher.poll("owner/repo", DEFAULT_CONFIG, "/tmp/test");
    expect(results).toHaveLength(0);
  });

  it("filters out unauthorized label adders", () => {
    vi.stubEnv("AUTO_DEV_ALLOWED_USERS", "admin,dev1");
    vi.mocked(listIssues).mockReturnValue([
      {
        number: 1,
        title: "Issue 1",
        labels: [{ name: "auto-dev:ready" }],
        body: "body",
        author: { login: "unauthorized-user" },
      },
    ]);
    vi.mocked(getReadyLabelAdder).mockReturnValue("unauthorized-user");

    const watcher = new IssueWatcher();
    const results = watcher.poll("owner/repo", DEFAULT_CONFIG, "/tmp/test");
    expect(results).toHaveLength(0);
  });

  it("denies all users when AUTO_DEV_ALLOWED_USERS is not configured", () => {
    delete process.env["AUTO_DEV_ALLOWED_USERS"];
    vi.mocked(listIssues).mockReturnValue([
      {
        number: 2,
        title: "Issue 2",
        labels: [{ name: "auto-dev:ready" }],
        body: "body",
        author: { login: "any-user" },
      },
    ]);
    vi.mocked(getReadyLabelAdder).mockReturnValue("any-user");

    const watcher = new IssueWatcher();
    const results = watcher.poll("owner/repo", DEFAULT_CONFIG, "/tmp/test");
    expect(results).toHaveLength(0);
  });

  it("allows users in the configured allowlist", () => {
    vi.stubEnv("AUTO_DEV_ALLOWED_USERS", "trusted-user");
    vi.mocked(listIssues).mockReturnValue([
      {
        number: 3,
        title: "Issue 3",
        labels: [{ name: "auto-dev:ready" }],
        body: "body",
        author: { login: "trusted-user" },
      },
    ]);
    vi.mocked(getReadyLabelAdder).mockReturnValue("trusted-user");

    const watcher = new IssueWatcher();
    const results = watcher.poll("owner/repo", DEFAULT_CONFIG, "/tmp/test");
    expect(results).toHaveLength(1);
    expect(results[0]?.issueNumber).toBe(3);
  });

  it("skips issue when label adder is null", () => {
    vi.stubEnv("AUTO_DEV_ALLOWED_USERS", "trusted-user");
    vi.mocked(listIssues).mockReturnValue([
      {
        number: 4,
        title: "Issue 4",
        labels: [{ name: "auto-dev:ready" }],
        body: "body",
        author: { login: "trusted-user" },
      },
    ]);
    vi.mocked(getReadyLabelAdder).mockReturnValue(null);

    const watcher = new IssueWatcher();
    const results = watcher.poll("owner/repo", DEFAULT_CONFIG, "/tmp/test");
    expect(results).toHaveLength(0);
  });
});
