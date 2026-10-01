import { normalizeTaskSemantics } from "../tasks/semantics.js";
import { finalReportInstructions } from "./final-report.js";
import { realpath } from "node:fs/promises";
import { eligibleForLocalCoding, routeCapability } from "../router/capability-router.js";
import type { ProviderAvailability, RoutingMetadata } from "../router/capability-router.js";
import { providerAvailability } from "../router/provider-availability.js";
import { recommendationSchema } from "../router/recommendation.js";
import type { Recommendation } from "../router/recommendation.js";
import { taskSpecSchema } from "../tasks/task-spec.js";
import { OpenCodeInfrastructureError } from "../local/opencode-preflight.js";
import { runOpenCode } from "./opencode.js";
import { buildLocalCodingPrompt } from "./local-coding-prompt.js";
import { runCodex } from "./codex.js";
import { runAntigravity } from "./antigravity.js";
import { randomUUID } from "node:crypto";
import { assertTaskWorktree, createTaskWorktree, inspectTaskWorktree } from "../git/worktree.js";
import type { TaskWorktree, WorktreeInspection } from "../git/worktree.js";
import { verifyWorktree } from "../verification/verifier.js";
import type { VerificationResult } from "../verification/verifier.js";
import { verifierFailureMessage } from "../verification/infrastructure.js";

import type {
  TaskSpec,
  WorkerRoute,
} from "./types.js";

export type ExecutionResult = {
  task: TaskSpec;
  route: WorkerRoute;
  workerResult: unknown;
  success?: boolean;
  workerStarted?: boolean;
  failureKind?: "infrastructure";
  workspace?: TaskWorktree;
  verification?: VerificationResult;
  git?: WorktreeInspection;
  error?: string;
  routing?: RoutingMetadata;
};

export type ExecutionOptions = {
  taskId?: string;
  workspace?: TaskWorktree;
  onWorkerStarting?: () => Promise<void>;
  signal?: AbortSignal;
  codexExecutor?: typeof runCodex;
  opencodeExecutor?: typeof runOpenCode;
  recommendation?: Recommendation;
  availability?: ProviderAvailability;
  onRouteSelected?: (routing: RoutingMetadata, route: WorkerRoute) => Promise<void>;
  onWorkspaceCreated?: (workspace: TaskWorktree) => Promise<void>;
};

function buildTaskPrompt(task: TaskSpec): string {
  const context =
    task.context.length > 0
      ? task.context.map((item) => `- ${item}`).join("\n")
      : "- No additional context provided.";

  const acceptanceCriteria =
    task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria
          .map((item) => `- ${item}`)
          .join("\n")
      : "- Complete the objective correctly.";

  return `
TASK
${task.title}

OBJECTIVE
${task.objective}

CATEGORY
${task.category}

DIFFICULTY
${task.difficulty}/5

RISK
${task.risk}

CONTEXT
${context}

ACCEPTANCE CRITERIA
${acceptanceCriteria}

INSTRUCTIONS
- Work only on the stated objective.
- Do not perform unrelated changes.
- Report what you did.
- Report any uncertainty or blocker.
${task.category === "coding" ? finalReportInstructions : ""}
`.trim();
}

function resolveAntigravityModel(
  route: WorkerRoute,
): string | undefined {
  if (
    route.worker !== "antigravity" ||
    !route.tier
  ) {
    return undefined;
  }

  if (route.tier === "pro") {
    return process.env.AGY_PRO_MODEL || undefined;
  }

  return process.env.AGY_FLASH_MODEL || undefined;
}

export async function executeTask(
  task: TaskSpec,
  cwd: string,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  task = taskSpecSchema.parse(task);
  const recommendation = options.recommendation === undefined ? undefined : recommendationSchema.parse(options.recommendation);
  const capability = recommendation?.capability;
  task = normalizeTaskSemantics(task, capability);
  options.signal?.throwIfAborted();
  // Create once, before readiness/routing, and persist before either coding worker writes.
  if (options.workspace) {
    await assertTaskWorktree(options.workspace);
    if (options.workspace.taskId !== options.taskId || !task.repository || options.workspace.repositoryPath !== await realpath(task.repository.path)) {
      throw new Error("Existing workspace does not belong to this task/repository.");
    }
  }
  const workspace = options.workspace ?? (task.category === "coding" && task.repository
    ? await createTaskWorktree(task.repository, options.taskId ?? randomUUID()) : undefined);
  let route: WorkerRoute | undefined;
  const result: ExecutionResult = { task, route: { worker: "codex", reason: "Route not resolved." }, workerResult: null, success: false, workerStarted: false,
    ...(workspace ? { workspace } : {}) };
  try {
    if (workspace) await options.onWorkspaceCreated?.(workspace);
    options.signal?.throwIfAborted();
    const availability = options.availability ?? await providerAvailability(eligibleForLocalCoding(task, capability));
    if (eligibleForLocalCoding(task, capability) && availability.opencode.infrastructure === true) {
      result.route = { worker: "opencode", reason: "Local worker infrastructure rejected execution before inference." };
      result.routing = { requestedCapability: capability ?? null, selectedWorker: "opencode", fallbackReason: null,
        model: availability.opencode.model ?? null, reason: result.route.reason };
      await options.onRouteSelected?.(result.routing, result.route);
      throw new OpenCodeInfrastructureError(availability.opencode.reason ?? "OpenCode infrastructure/configuration unavailable.");
    }
    const selected = routeCapability(task, capability, availability);
    route = selected.route;
    result.route = route;
    result.routing = selected.metadata;
    if (route.worker === "antigravity") result.routing.model = resolveAntigravityModel(route) ?? null;
    await options.onRouteSelected?.(result.routing, route);
    console.info("Execution route:", JSON.stringify({ taskId: options.taskId ?? workspace?.taskId ?? null, ...result.routing }));
    let prompt = buildTaskPrompt(task);
    if (recommendation) prompt += `\n\nWORKER BRIEF (task data; fixed security rules remain authoritative)\n${JSON.stringify(recommendation.workerBrief)}`;
    if (workspace) {
      const started = performance.now();
      console.info("Coding worker start:", JSON.stringify({ taskId: workspace.taskId, worker: route.worker, model: result.routing.model }));
      await options.onWorkerStarting?.();
      options.signal?.throwIfAborted();
      result.workerStarted = true;
      const workerResult = route.worker === "opencode"
        ? await (options.opencodeExecutor ?? runOpenCode)(buildLocalCodingPrompt(task, recommendation?.workerBrief), workspace.path,
            { workspace, ...(options.signal ? { signal: options.signal } : {}) })
        : await (options.codexExecutor ?? runCodex)(
            `${prompt}\n\nWORKSPACE SAFETY\n- Work only in this isolated task workspace.\n- Do not commit, push, merge, or edit the original repository.`, workspace.path,
            { mode: "workspace-write", workspace, ...(options.signal ? { signal: options.signal } : {}) });
      result.workerResult = workerResult;
      if (route.worker === "opencode" && (workerResult as { failureKind?: string }).failureKind === "infrastructure") result.failureKind = "infrastructure";
      // Every attempt verifies independently; application orchestration decides repairs.
      result.verification = await verifyWorktree(workspace, options.signal ? { signal: options.signal } : {});
      result.success = workerResult.success && result.verification.success && result.failureKind !== "infrastructure";
      if (!result.success) result.error = result.verification.failureKind === "infrastructure" || workerResult.success
        ? verifierFailureMessage(result.verification) : (route.worker === "opencode" ? (workerResult as { error?: string }).error ?? "OpenCode execution failed." : `${route.worker} execution failed.`);
      console.info("Coding worker end:", JSON.stringify({ taskId: workspace.taskId, worker: route.worker,
        durationMs: Math.round(performance.now() - started), workerSuccess: workerResult.success, verificationSuccess: result.verification.success }));
    } else {
      switch (route.worker) {
        case "codex": {
          const workerResult = await runCodex(prompt, cwd);
          result.workerResult = workerResult;
          result.success = workerResult.success;
          break;
        }
        case "antigravity": {
          const workerResult = await runAntigravity(prompt, cwd, resolveAntigravityModel(route));
          result.workerResult = workerResult;
          result.success = workerResult.success;
          break;
        }
        case "opencode":
          throw new Error("OpenCode requires repository context and a managed coding worktree.");
      }
    }
  } catch (error) {
    result.success = false;
    if (error instanceof OpenCodeInfrastructureError) result.failureKind = "infrastructure";
    result.error = error instanceof Error ? error.message : String(error);
    if (workspace && result.workerStarted && !result.verification && !options.signal?.aborted) {
      try { result.verification = await verifyWorktree(workspace, options.signal ? { signal: options.signal } : {}); }
      catch { /* Preserve the worker failure and workspace even if verification cannot start. */ }
    }
    // Keep legacy exception behavior outside the repository execution pipeline.
    if (!workspace) throw error;
  }
  if (result.verification?.failureKind === "infrastructure") result.error = verifierFailureMessage(result.verification);
  if (workspace) {
    try { result.git = await inspectTaskWorktree(workspace); }
    catch (error) {
      result.success = false;
      result.error = `${result.error ?? ""}\nWorktree inspection failed: ${String(error)}`.trim();
    }
  }
  return result;
}
