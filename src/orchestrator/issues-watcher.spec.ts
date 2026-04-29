import { describe, it, expect, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config/types.js";
import { IssueWatcher } from "./issues-watcher.js";

vi.mock("../shared/gh-cli.js", () => ({
  listIssues: vi.fn(),
}));

import { listIssues } from "../shared/gh-cli.js";

describe("IssueWatcher", () => {
  it("returns empty array when gh CLI errors", () => {
    vi.mocked(listIssues).mockImplementation(() => {
      throw new Error("Network error");
    });

    const watcher = new IssueWatcher();
    const results = watcher.poll("owner/repo", DEFAULT_CONFIG, "/tmp/test");
    expect(results).toEqual([]);
  });

  it("filters out human-only issues", () => {
    vi.mocked(listIssues).mockReturnValue([
      {
        number: 1,
        title: "Issue 1",
        labels: [{ name: "auto-dev:ready" }, { name: "human-only" }],
        body: "body",
        author: { login: "allowed-user" },
      },
    ]);

    const watcher = new IssueWatcher();
    const results = watcher.poll("owner/repo", DEFAULT_CONFIG, "/tmp/test");
    expect(results).toHaveLength(0);
  });

  it("filters out unauthorized users", () => {
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

    const watcher = new IssueWatcher();
    const results = watcher.poll("owner/repo", DEFAULT_CONFIG, "/tmp/test");
    expect(results).toHaveLength(0);
    vi.unstubAllEnvs();
  });
});
