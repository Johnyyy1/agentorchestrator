export type ChiefErrorCode = "invalid_input" | "invalid_json" | "invalid_decision" | "ungrounded_repository" | "submission_failed";

export class ChiefError extends Error {
  constructor(public readonly code: ChiefErrorCode, message: string) {
    super(message);
    this.name = "ChiefError";
  }
}
