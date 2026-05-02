import { execFileSync } from "node:child_process";

import { createPRWithDraft, getPRStatus } from "@/shared/gh-cli.js";
import { getAuthEnv } from "@/shared/github-app-auth.js";

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
    return createPRWithDraft(
      this.repoFullName,
      title,
      body,
      branch,
      base,
      draft,
    );
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
    return getPRStatus(this.repoFullName, prNumber);
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
