import type { TaskSpec } from "../workers/types.js";
import type { TaskWorktree } from "../git/worktree.js";
import type { ExecutionResult } from "../workers/execute.js";
import { assertIndependent, providerFamily } from "../review/policy.js";
import { reviewSchema } from "../review/schema.js";

export class CompletionInvariantError extends Error {
  constructor(detail: string) {
    super(`Execution incomplete: repository mutation was not verified. ${detail}`);
    this.name = "CompletionInvariantError";
  }
}

export function isVerifiedCodingExecution(result: ExecutionResult | undefined): boolean {
  const worker = result?.workerResult as { success?: boolean; message?: unknown } | null;
  return result?.success === true && result.workerStarted === true &&
    (result.route?.worker === "opencode" || result.route?.worker === "codex") &&
    worker?.success === true && typeof worker.message === "string" && worker.message.trim().length > 0 &&
    !!result.workspace && !!result.git && Array.isArray(result.git.changedFiles) &&
    result.verification?.success === true && Array.isArray(result.verification.checks) &&
    result.verification.checks.length > 0 && result.verification.checks.every(check => check.success === true);
}

type Attempt = { id: string; taskId: string; worker: string; status: string; workspace: TaskWorktree | null; result: unknown };
type Review = { runId: string; taskId: string; reviewer: string; providerFamily: string; status: string; result: unknown };

export function assertCodingCompletion(taskId: string, task: TaskSpec, run?: Attempt, review?: Review): void {
  const result = run?.result as ExecutionResult | undefined;
  if (!task.repository || task.category !== "coding" || !run || run.taskId !== taskId || run.status !== "completed" ||
      !isVerifiedCodingExecution(result) || run.worker !== result!.route.worker || !run.workspace ||
      run.workspace.taskId !== taskId || run.workspace.path === run.workspace.repositoryPath ||
      ["path", "repositoryPath", "branch", "baseBranch", "baseCommit", "taskId"].some(key => {
        const field = key as keyof TaskWorktree;
        return !run.workspace![field] || run.workspace![field] !== result!.workspace![field];
      })) throw new CompletionInvariantError("Successful coding attempt, retained workspace or verifier evidence is missing.");
  const verdict = reviewSchema.safeParse(review?.result);
  if (!review || review.taskId !== taskId || review.runId !== run.id || review.status !== "completed" ||
      !verdict.success || verdict.data.decision !== "approve" ||
      review.providerFamily !== providerFamily[review.reviewer as keyof typeof providerFamily]) {
    throw new CompletionInvariantError("Independent approval for the final attempt is missing.");
  }
  try { assertIndependent(result!.route.worker, review.reviewer as "codex" | "antigravity"); }
  catch { throw new CompletionInvariantError("Review provider is not independent of the coding worker."); }
}
