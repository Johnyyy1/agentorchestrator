import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db/index.js";
import { tasks, runs, reviews, escalations, orchestrationEvents } from "../db/schema.js";
import { inspectTaskWorktree } from "../git/worktree.js";
import { verifyWorktree } from "../verification/verifier.js";
import { verifierFailureMessage } from "../verification/infrastructure.js";
import { taskRowToSpec } from "../tasks/task-spec.js";
import { recommendationSchema } from "../router/recommendation.js";
import { executeTask } from "../workers/execute.js";
import type { ExecutionOptions, ExecutionResult } from "../workers/execute.js";
import { decideRepair } from "../chief/repair.js";
import { repairDecisionSchema } from "../chief/repair-schema.js";
import { getOllamaConfig } from "../local/ollama.js";
import { assertIndependent, providerFamily, reviewerCandidates } from "../review/policy.js";
import type { ReviewerId } from "../review/policy.js";
import { reviewerAvailability, runReview } from "../review/adapter.js";
import type { ReviewerAvailability } from "../review/adapter.js";
import { reviewSchema } from "../review/schema.js";
import { ReviewFailure, type ReviewDiagnostics } from "../review/diagnostics.js";
import { buildRepairContext } from "./context.js";
import type { RepairContext } from "./context.js";
import { effectiveAttempts, orchestrationStateSchema, assertTransition } from "./state.js";
import { isVerifiedCodingExecution as isVerified, CompletionInvariantError } from "./completion.js";
import { saveState } from "./persistence.js";
import { openEscalation } from "../escalations/service.js";

export type OrchestrationOptions = {
  executor?: (task: Parameters<typeof executeTask>[0], cwd: string, options: ExecutionOptions) => Promise<ExecutionResult>;
  repair?: (context: RepairContext, signal: AbortSignal) => Promise<unknown>;
  review?: (reviewer: ReviewerId, context: RepairContext, signal: AbortSignal) => Promise<unknown>;
  reviewerAvailability?: () => Promise<ReviewerAvailability>;
  chiefModel?: string;
  cwd?: string; signal?: AbortSignal;
};
// A session lock lasts across all transitions/provider calls; another process cannot execute this task.
// A crashed owner releases the lock, but persisted in-flight phases remain ambiguous and escalate.
export async function orchestrateCodingTask(taskId: string, options: OrchestrationOptions = {}): Promise<void> {
  z.uuid().parse(taskId);
  const client = await pool.connect();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason ?? new Error("Orchestration interrupted."));
  const lost = () => controller.abort(new Error("Orchestration database lock connection lost."));
  client.on("error", lost);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as locked", [taskId]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) return;
    for (let step = 0; step < 30; step++) {
      controller.signal.throwIfAborted();
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      if (!row) throw new Error("Task does not exist.");
      if (["completed", "failed", "waiting_human"].includes(row.status)) return;
      let spec;
      let state;
      try {
        spec = taskRowToSpec(row);
        state = orchestrationStateSchema.parse(row.orchestration ?? { phase: row.status === "running" ? "executing" : "ready" });
      } catch {
        await saveState(taskId, "failed", { phase: "done" }, "invalid_state");
        return;
      }
      if (spec.category !== "coding" || !spec.repository) throw new Error("Coding orchestration requires a repository task.");
      const history = await db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.attempt));
      const latest = history.at(-1);
      const result = latest?.result as ExecutionResult | undefined;
      const limit = effectiveAttempts(spec.maxAttempts);
      const attempt = history.reduce((max, run) => Math.max(max, run.attempt), 0);
      const escalate = async (reason: Parameters<typeof openEscalation>[2], question: string, summary: string) => {
        await openEscalation(taskId, latest?.id, reason, question, summary, { attempt, maxAttempts: limit, phase: state.phase });
      };
      if (result?.failureKind === "infrastructure") {
        await escalate("infrastructure", "Repair the local worker runtime/configuration and inspect its retained worktree before resuming.",
          result.error?.slice(0, 500) ?? "Local worker infrastructure failed; no automatic coding repair.");
        return;
      }
      if (result?.verification?.failureKind === "infrastructure") {
        await escalate("infrastructure", "Repair verifier infrastructure and inspect the retained worktree. This unchanged diff must not launch another coding attempt.",
          verifierFailureMessage(result.verification));
        return;
      }
      if (["executing", "deciding", "reviewing"].includes(state.phase)) {
        await db.update(runs).set({ status: "failed", failureKind: "interrupted", error: "Ambiguous interrupted invocation; automatic repetition refused.", finishedAt: new Date() })
          .where(and(eq(runs.taskId, taskId), eq(runs.status, "running")));
        await db.update(reviews).set({ status: "interrupted", error: "Ambiguous interrupted review; automatic repetition refused.", finishedAt: new Date() })
          .where(and(eq(reviews.taskId, taskId), eq(reviews.status, "running")));
        await escalate("infrastructure", "Inspect retained work and any provider process. Has it stopped, and how should this task continue?",
          "Interrupted provider invocation has an unknown outcome. No automatic replay.");
        return;
      }
      const previousEvents = await db.select().from(orchestrationEvents).where(and(eq(orchestrationEvents.taskId, taskId), eq(orchestrationEvents.kind, "repair_decided"))).orderBy(asc(orchestrationEvents.createdAt));
      const decisions = previousEvents.map(event => repairDecisionSchema.parse((event.data as { decision: unknown }).decision));
      const answers = await db.select().from(escalations).where(and(eq(escalations.taskId, taskId), eq(escalations.status, "resolved"))).orderBy(asc(escalations.resolvedAt));
      const [reviewRow] = latest ? await db.select().from(reviews).where(eq(reviews.runId, latest.id)) : [];
      if (reviewRow?.status === "failed" && reviewRow.error?.startsWith("Reviewer infrastructure failure:")) {
        await escalate("infrastructure", "Repair independent reviewer infrastructure and inspect the verified retained worktree. Do not reauthor this unchanged diff.", reviewRow.error);
        return;
      }
      const verdict = reviewRow?.result ? reviewSchema.parse(reviewRow.result) : null;
      const context = () => buildRepairContext(spec, row.chief?.workerBrief, attempt, limit, result, decisions, verdict,
        answers.map(item => ({ question: item.question, answer: item.answer ?? "" })));

      if (state.phase === "ready") {
        if (attempt >= limit) { await escalate("max_attempts", "Attempt limit reached. Inspect the work, abandon this task, or create a new explicitly bounded task.", "No further worker attempt is permitted."); return; }
        const workspace = history.find(run => run.workspace)?.workspace;
        const recommendation = state.recommendation ?? (row.chief ? recommendationSchema.parse(row.chief) : undefined);
        const [run] = await db.transaction(async tx => {
          assertTransition(row.status, "running");
          const inserted = await tx.insert(runs).values({ taskId, attempt: attempt + 1, worker: "codex", status: "running", parentRunId: latest?.id ?? null,
            ...(workspace ? { workspace } : {}) }).returning();
          if (!inserted[0]) throw new Error("Run insert failed.");
          await tx.update(tasks).set({ status: "running", orchestration: { ...state, phase: "executing", latestRunId: inserted[0].id }, updatedAt: new Date() }).where(eq(tasks.id, taskId));
          await tx.insert(orchestrationEvents).values({ taskId, runId: inserted[0].id, kind: "attempt_reserved", data: { attempt: attempt + 1, maxAttempts: limit, previousWorker: latest?.worker ?? null } });
          return inserted;
        });
        if (!run) throw new Error("Run insert failed.");
        console.info("Worker attempt:", JSON.stringify({ taskId, attempt: run.attempt, maxAttempts: limit, reason: state.decision?.reason ?? "initial" }));
        let output: ExecutionResult;
        try {
          output = await (options.executor ?? executeTask)(spec, options.cwd ?? process.cwd(), {
            taskId, signal: controller.signal, ...(workspace ? { workspace } : {}), ...(recommendation ? { recommendation } : {}),
            onWorkspaceCreated: async workspace => { controller.signal.throwIfAborted(); await db.update(runs).set({ workspace }).where(eq(runs.id, run.id)); },
            onRouteSelected: async (routing, route) => {
              controller.signal.throwIfAborted();
              await db.update(runs).set({ routing, worker: route.worker, tier: route.tier ?? null }).where(eq(runs.id, run.id));
            },
            onWorkerStarting: async () => {
              controller.signal.throwIfAborted();
              await db.insert(orchestrationEvents).values({ taskId, runId: run.id, kind: "worker_started", data: { attempt: run.attempt } });
            },
          });
        } catch {
          // A thrown adapter may have written files. Its persisted workspace is retained for diagnosis.
          const [saved] = await db.select().from(runs).where(eq(runs.id, run.id));
          const started = await db.select({ id: orchestrationEvents.id }).from(orchestrationEvents)
            .where(and(eq(orchestrationEvents.runId, run.id), eq(orchestrationEvents.kind, "worker_started")));
          output = { task: spec, workerStarted: started.length > 0, route: { worker: saved?.worker as ExecutionResult["route"]["worker"] ?? "codex", reason: "Adapter threw." },
            workerResult: null, success: false, error: "Execution adapter threw; inspect partial work.", ...(saved?.workspace ? { workspace: saved.workspace } : {}) };
          if (saved?.workspace) {
            try { output.git = await inspectTaskWorktree(saved.workspace); } catch { /* Preserve the original failed invocation. */ }
            if (output.workerStarted && !controller.signal.aborted) {
              try { output.verification = await verifyWorktree(saved.workspace, { signal: controller.signal }); } catch { /* Failed verification remains failed. */ }
            }
          }
        }
        controller.signal.throwIfAborted();
        await db.transaction(async tx => {
          await tx.update(runs).set({ result: output, ...(output.workspace ? { workspace: output.workspace } : {}), status: isVerified(output) ? "completed" : "failed", finishedAt: new Date(),
            failureKind: isVerified(output) ? null : output.failureKind === "infrastructure" || output.verification?.failureKind === "infrastructure" || output.workerStarted === false ? "infrastructure" : (output.workerResult as { success?: boolean } | null)?.success !== true ? "execution" : "verification",
            error: output.verification?.failureKind === "infrastructure" ? verifierFailureMessage(output.verification) : output.error ?? null }).where(eq(runs.id, run.id));
          await tx.update(tasks).set({ orchestration: { ...state, phase: "after_attempt", latestRunId: run.id }, updatedAt: new Date() }).where(eq(tasks.id, taskId));
          await tx.insert(orchestrationEvents).values({ taskId, runId: run.id, kind: "attempt_finished", data: { attempt: run.attempt, worker: output.route.worker, verified: isVerified(output) } });
        });
        continue;
      }
      if (state.phase === "after_attempt") {
        if (!latest) throw new CompletionInvariantError("Attempt history is missing.");
        if (result?.success === true && !isVerified(result)) throw new CompletionInvariantError("Successful execution claim lacks coding workspace, inspection or verifier evidence.");
        await saveState(taskId, isVerified(result) ? "reviewing" : "repairing", { ...state, phase: isVerified(result) ? "review" : "decide" }, "verification_decided", { verified: isVerified(result) });
        continue;
      }
      if (state.phase === "decide") {
        // Human guidance never replenishes the immutable worker attempt budget.
        if (attempt >= limit && !state.resumeEscalationId) { await escalate("max_attempts", "Attempt limit reached. Inspect retained work and decide whether to abandon or create a new task.", "Worker budget exhausted."); return; }
        const input = await context();
        await saveState(taskId, "repairing", { ...state, phase: "deciding" }, "repair_started", { attempt, model: options.chiefModel ?? getOllamaConfig().model });
        let decision;
        try { decision = repairDecisionSchema.parse(await (options.repair ?? ((context, signal) => decideRepair(context, { signal })))(input, controller.signal)); }
        catch { await escalate("infrastructure", "The repair Chief is unavailable or returned an invalid decision. Inspect readiness and provide guidance.", "No worker was invoked after the failed Chief decision."); return; }
        controller.signal.throwIfAborted();
        const { resumeEscalationId: _consumedAnswer, ...nextState } = state;
        await saveState(taskId, "repairing", { ...nextState, phase: "decision", decision }, "repair_decided", { decision, attempt, model: options.chiefModel ?? getOllamaConfig().model });
        continue;
      }
      if (state.phase === "decision") {
        const decision = repairDecisionSchema.parse(state.decision);
        if (decision.action !== "repair") {
          await escalate(decision.action === "ask_human" ? "clarification" : "other", decision.action === "ask_human" ? decision.humanQuestion : "The Chief recommends stopping. How should the retained work be handled?", `${decision.summary}: ${decision.reason}`);
          return;
        }
        if (attempt >= limit) { await escalate("max_attempts", "No worker budget remains. Abandon this task or create a new bounded task after inspecting retained work.", decision.reason); return; }
        const reviewedAfterAnswer = reviewRow && !answers.some(answer => answer.resolvedAt && answer.resolvedAt >= reviewRow.createdAt);
        if (verdict && ["high", "critical"].includes(verdict.severity) && reviewedAfterAnswer) {
          await escalate(verdict.findings.some(f => f.category === "security") ? "security" : "review", "High-severity review requires a human decision before repair. What is authorized?", decision.reason);
          return;
        }
        const strongRequired = spec.risk === "high" || history.some(run => run.worker === "codex") || (verdict && ["high", "critical"].includes(verdict.severity));
        const recommendation = { capability: strongRequired ? "strong-coding" as const : decision.capability, workerBrief: decision.repairBrief };
        await saveState(taskId, "repairing", { ...state, phase: "ready", recommendation }, "repair_authorized", { requestedCapability: decision.capability, enforcedCapability: recommendation.capability, reason: decision.reason });
        continue;
      }
      if (state.phase === "review") {
        if (!latest || !isVerified(result)) { await escalate("other", "Verification evidence is missing. Inspect the persisted attempt.", "Review cannot waive verification."); return; }
        if (reviewRow) { await escalate("review", "This attempt already has a review. Inspect the recorded outcome before continuing.", "At most one review invocation per attempt."); return; }
        const available = await (options.reviewerAvailability ?? reviewerAvailability)();
        const reviewer = reviewerCandidates(result!.route.worker).find(candidate => available[candidate]?.available);
        if (!reviewer) { await escalate("infrastructure", "No independent read-only reviewer is available. Configure an independent provider and provide guidance.", "Completion requires independent approval."); return; }
        assertIndependent(result!.route.worker, reviewer);
        const input = await context();
        if (input.omitted) { await escalate("review", "The bounded review snapshot omits changes. Inspect the full worktree before deciding how to continue.", "Incomplete evidence cannot receive automatic approval."); return; }
        const [review] = await db.transaction(async tx => {
          const inserted = await tx.insert(reviews).values({ taskId, runId: latest.id, reviewer, providerFamily: providerFamily[reviewer], model: available[reviewer]?.model ?? null, status: "running" }).returning();
          await tx.update(tasks).set({ status: "reviewing", orchestration: { ...state, phase: "reviewing" }, updatedAt: new Date() }).where(eq(tasks.id, taskId));
          await tx.insert(orchestrationEvents).values({ taskId, runId: latest.id, kind: "review_started", data: { reviewer, attempt } });
          return inserted;
        });
        if (!review) throw new Error("Review insert failed.");
        console.info("Independent review:", JSON.stringify({ taskId, attempt, reviewer, author: result!.route.worker }));
        let reviewed;
        let diagnostics: ReviewDiagnostics | undefined;
        try {
          reviewed = reviewSchema.parse(await (options.review
            ? options.review(reviewer, input, controller.signal)
            : runReview(reviewer, input, controller.signal, { onDiagnostics: value => { diagnostics = value; } })));
        } catch (error) {
          const failureKind = error instanceof ReviewFailure ? error.diagnostics.failureKind ?? "infrastructure"
            : error instanceof z.ZodError ? "result" : "infrastructure";
          diagnostics ??= error instanceof ReviewFailure ? error.diagnostics : undefined;
          const message = error instanceof ReviewFailure ? error.message : `Reviewer ${failureKind} failure: ${failureKind === "result" ? "structured schema validation failed" : "invocation unavailable"}.`;
          await db.transaction(async tx => {
            await tx.update(reviews).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(reviews.id, review.id));
            await tx.insert(orchestrationEvents).values({ taskId, runId: latest.id, kind: "review_failed", data: { reviewer, failureKind, ...(diagnostics ? { diagnostics } : {}) } });
          });
          await escalate(failureKind === "infrastructure" ? "infrastructure" : "review", "Independent review failed. Inspect safe diagnostics and the retained verified attempt.", message); return;
        }
        controller.signal.throwIfAborted();
        await db.transaction(async tx => {
          await tx.update(reviews).set({ status: "completed", result: reviewed, finishedAt: new Date() }).where(eq(reviews.id, review.id));
          await tx.update(tasks).set({ orchestration: { ...state, phase: "reviewed" }, updatedAt: new Date() }).where(eq(tasks.id, taskId));
          await tx.insert(orchestrationEvents).values({ taskId, runId: latest.id, kind: "review_finished", data: { reviewer, decision: reviewed.decision, severity: reviewed.severity, ...(diagnostics ? { diagnostics } : {}) } });
        });
        continue;
      }
      if (state.phase === "reviewed") {
        if (!isVerified(result) || !verdict || reviewRow?.status !== "completed") throw new CompletionInvariantError("Review/verification evidence missing.");
        assertIndependent(result!.route.worker, reviewRow.reviewer as ReviewerId);
        if (verdict.decision === "approve") { await saveState(taskId, "completed", { ...state, phase: "done" }, "completed", { reviewId: reviewRow.id }); return; }
        if (verdict.decision === "needs_human") { await escalate("review", verdict.humanQuestion, verdict.summary); return; }
        await saveState(taskId, "repairing", { ...state, phase: "decide" }, "review_changes_requested", { severity: verdict.severity });
        continue;
      }
      throw new Error(`Unexpected orchestration phase ${state.phase}.`);
    }
    throw new Error("Orchestration transition safety cap reached.");
  } catch (error) {
    if (locked && !controller.signal.aborted) {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      if (row && !["completed", "failed", "waiting_human"].includes(row.status)) {
        await openEscalation(taskId, row.orchestration?.latestRunId, "infrastructure", "Inspect task state, provider processes and retained work before resuming.", error instanceof CompletionInvariantError ? error.message : "Orchestration stopped safely after an infrastructure failure.");
        return;
      }
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    client.removeListener("error", lost);
    try { if (locked) await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [taskId]); }
    finally { client.release(controller.signal.aborted ? new Error("Interrupted orchestration lock") : undefined); }
  }
}

export async function recoverCodingTasks(options: OrchestrationOptions = {}, queueName = "jonas-os.tasks.execute") {
  const active = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.queueName, queueName),
    inArray(tasks.status, ["running", "repairing", "reviewing"])));
  for (const task of active) {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    if (!row) continue;
    try {
      if (taskRowToSpec(row).category !== "coding") continue;
    } catch {
      await saveState(task.id, "failed", { phase: "done" }, "invalid_state", { error: "Coding tasks require repository context." });
      continue;
    }
    if (row.category !== "coding") await db.update(tasks).set({ category: "coding", updatedAt: new Date() }).where(eq(tasks.id, task.id));
    await orchestrateCodingTask(task.id, options);
  }
}
