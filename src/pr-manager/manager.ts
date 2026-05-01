import { execFileSync } from "node:child_process";

import { getAuthEnv } from "../shared/github-app-auth.js";

export class PRManager {
  private readonly repoFullName: string;

  constructor(repoFullName: string) {
    this.repoFullName = repoFullName;
  }

  create(
    branch: string,
    title: string,
    body: string,
    base = "main",
    draft = false,
  ): { number: number; url: string } {
    const args = [
      "pr",
      "create",
      "--repo",
      this.repoFullName,
      "--base",
      base,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ];
    if (draft) args.push("--draft");
    const output = execFileSync("gh", args, {
      encoding: "utf-8",
      env: { ...process.env, ...getAuthEnv() },
    }).trim();
    const match = output.match(/\/pull\/(\d+)/);
    if (!match) {
      throw new Error(`Failed to parse PR number from gh output: ${output}`);
    }
    return { number: parseInt(match[1], 10), url: output };
  }

  close(prNumber: number, deleteBranch = false): void {
    const args = ["pr", "close", String(prNumber), "--repo", this.repoFullName];
    if (deleteBranch) args.push("--delete-branch");
    execFileSync("gh", args, {
      encoding: "utf-8",
      env: { ...process.env, ...getAuthEnv() },
    });
  }

  getStatus(prNumber: number): string {
    return execFileSync(
      "gh",
      [
        "pr",
        "view",
        String(prNumber),
        "--repo",
        this.repoFullName,
        "--json",
        "state,mergeable,reviews",
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, ...getAuthEnv() },
      },
    ).trim();
  }

  enableAutoMerge(prNumber: number): void {
    execFileSync(
      "gh",
      [
        "pr",
        "merge",
        String(prNumber),
        "--auto",
        "--squash",
        "--repo",
        this.repoFullName,
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, ...getAuthEnv() },
      },
    );
  }
}
