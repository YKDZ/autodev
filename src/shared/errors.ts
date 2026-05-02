export class DecisionLimitReachedError extends Error {
  public readonly remainingDecisions: number;

  constructor(max: number) {
    super(`Decision limit reached (max: ${max})`);
    this.name = "DecisionLimitReachedError";
    this.remainingDecisions = 0;
  }
}

export class DecisionNotFoundError extends Error {
  constructor(decisionId: string) {
    super(`Decision not found: ${decisionId}`);
    this.name = "DecisionNotFoundError";
  }
}

export class InvalidDecisionChoiceError extends Error {
  public readonly decisionId: string;
  public readonly choice: string;
  public readonly allowedChoices: string[];

  constructor(decisionId: string, choice: string, allowedChoices: string[]) {
    super(
      `Invalid choice "${choice}" for decision ${decisionId}. Allowed: ${allowedChoices.join(", ")}`,
    );
    this.name = "InvalidDecisionChoiceError";
    this.decisionId = decisionId;
    this.choice = choice;
    this.allowedChoices = allowedChoices;
  }
}

export class SocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketError";
  }
}

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(`Configuration error: ${message}`);
    this.name = "ConfigLoadError";
  }
}

export class ValidationError extends Error {
  public readonly details: string[];

  constructor(details: string[]) {
    super(`Validation failed: ${details.join("; ")}`);
    this.name = "ValidationError";
    this.details = details;
  }
}

export class BranchSourceError extends Error {
  constructor(branch: string, detail: string) {
    super(`Branch source verification failed for ${branch}: ${detail}`);
    this.name = "BranchSourceError";
  }
}

export class GitHubAppAuthError extends Error {
  constructor(message: string) {
    super(`GitHub App auth error: ${message}`);
    this.name = "GitHubAppAuthError";
  }
}

export class TriggerCommentError extends Error {
  constructor(message: string) {
    super(`Trigger comment error: ${message}`);
    this.name = "TriggerCommentError";
  }
}
