import type { TaskSpec, WorkerId } from "../workers/types.js";
import type { ExecutionResult } from "../workers/execute.js";
import type { RepairDecision } from "../chief/repair-schema.js";
import type { ReviewResult } from "../review/schema.js";
import { boundedWorktreeDiff } from "../git/worktree.js";

export function redact(value: string): string {
  return value.replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, "[REDACTED KEY]")
    .replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|Bearer\s+[\w.\/-]+)/gi, "[REDACTED]")
    .replace(/((?:password|secret|api[_-]?key|token)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
const clip = (text: string | undefined, max: number) => redact(text ?? "").slice(0, max);
export type RepairContext = {
  title: string; objective: string; taskContext: string[]; acceptanceCriteria: string[]; originalWorkerBrief: string;
  attempt: number; maxAttempts: number; worker: WorkerId | null; workerSummary: string; error: string;
  verification: Array<{ name: string; success: boolean; skipped: boolean; stdout: string; stderr: string }>;
  changedFiles: string[]; diffStat: string; diff: string; omitted: boolean;
  previousDecisions: RepairDecision[]; review: ReviewResult | null; humanAnswers: Array<{ question: string; answer: string }>;
};
export async function buildRepairContext(task: TaskSpec, originalBrief: string | undefined, attempt: number, maxAttempts: number,
  result: ExecutionResult | undefined, decisions: RepairDecision[], review: ReviewResult | null,
  humanAnswers: RepairContext["humanAnswers"]): Promise<RepairContext> {
  const snapshot = result?.workspace ? await boundedWorktreeDiff(result.workspace) : { diff: "", omitted: false };
  const workerResult = result?.workerResult as { message?: string } | null | undefined;
  const context: RepairContext = {
    title: clip(task.title, 300), objective: clip(task.objective, 2500),
    taskContext: task.context.slice(0, 5).map(value => clip(value, 400)),
    acceptanceCriteria: task.acceptanceCriteria.slice(0, 10).map(value => clip(value, 500)),
    originalWorkerBrief: clip(originalBrief, 2000), attempt, maxAttempts, worker: result?.route.worker ?? null,
    workerSummary: clip(workerResult?.message, 1000), error: clip(result?.error, 1000),
    verification: (result?.verification?.checks ?? []).slice(0, 4).map(check => ({ name: check.name, success: check.success,
      skipped: check.skipped, stdout: check.success ? "" : clip(check.stdout, 750), stderr: clip(check.stderr, 750) })),
    changedFiles: (result?.git?.changedFiles ?? []).slice(0, 30).map(path => clip(path, 300)),
    diffStat: clip(result?.git?.diffStat, 1000), diff: clip(snapshot.diff, 12000), omitted: snapshot.omitted || task.acceptanceCriteria.length > 10 || task.acceptanceCriteria.some(value => value.length > 500) || task.objective.length > 2500,
    previousDecisions: decisions.slice(-2).map(value => value.action === "repair"
      ? { ...value, repairBrief: clip(value.repairBrief, 500), reason: clip(value.reason, 500), summary: clip(value.summary, 300) }
      : value.action === "ask_human" ? { ...value, humanQuestion: clip(value.humanQuestion, 500), reason: clip(value.reason, 500), summary: clip(value.summary, 300) }
      : { ...value, reason: clip(value.reason, 500), summary: clip(value.summary, 300) }),
    review: review ? { ...review, findings: review.findings.slice(0, 5).map(f => ({ ...f, description: clip(f.description, 500),
      reason: clip(f.reason, 500), ...(f.suggestedFix ? { suggestedFix: clip(f.suggestedFix, 500) } : {}) })) } : null,
    humanAnswers: humanAnswers.slice(-3).map(item => ({ question: clip(item.question, 500), answer: clip(item.answer, 1500) })),
  };
  while (JSON.stringify(context).length > 32000 && context.diff.length > 0) {
    context.diff = context.diff.slice(0, Math.floor(context.diff.length / 2)); context.omitted = true;
  }
  if (JSON.stringify(context).length > 32000) {
    context.omitted = true; context.previousDecisions = []; context.changedFiles = context.changedFiles.slice(0, 10);
    context.acceptanceCriteria = context.acceptanceCriteria.slice(0, 5).map(value => clip(value, 300));
    context.humanAnswers = context.humanAnswers.slice(-1).map(value => ({ question: clip(value.question, 300), answer: clip(value.answer, 500) }));
    context.review = context.review ? { ...context.review, summary: clip(context.review.summary, 500), findings: context.review.findings.slice(0, 1) } : null;
    context.verification = context.verification.map(value => ({ ...value, stdout: clip(value.stdout, 300), stderr: clip(value.stderr, 300) }));
  }
  return context;
}
