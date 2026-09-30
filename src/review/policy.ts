import type { WorkerId } from "../workers/types.js";
export type ReviewerId = "antigravity" | "codex";
export const providerFamily: Record<WorkerId, string> = { opencode: "qwen", codex: "openai", antigravity: "google" };
export function reviewerCandidates(author: WorkerId): ReviewerId[] {
  return author === "opencode" ? ["antigravity", "codex"] : author === "codex" ? ["antigravity"] : ["codex"];
}
export function assertIndependent(author: WorkerId, reviewer: WorkerId): void {
  if (!reviewerCandidates(author).includes(reviewer as ReviewerId) || providerFamily[author] === providerFamily[reviewer]) {
    throw new Error("Reviewer must use an independent provider/model family.");
  }
}
