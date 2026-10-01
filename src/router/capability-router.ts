import { normalizeTaskSemantics } from "../tasks/semantics.js";
import type { Capability } from "../chief/capabilities.js";
import { routeTask } from "./router.js";
import type { TaskSpec, WorkerId, WorkerRoute } from "../workers/types.js";

export type ProviderStatus = { available: boolean; reason?: string; model?: string };
export type ProviderAvailability = Record<WorkerId, ProviderStatus>;
export type RoutingMetadata = {
  requestedCapability: Capability | null;
  selectedWorker: WorkerId;
  fallbackReason: string | null;
  model: string | null;
  reason: string;
};
export type CapabilityRoute = { route: WorkerRoute; metadata: RoutingMetadata };

export function localCodingMaxDifficulty(): number {
  const value = Number(process.env.LOCAL_CODING_MAX_DIFFICULTY ?? 2);
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error("LOCAL_CODING_MAX_DIFFICULTY must be an integer from 1 to 3.");
  }
  return value;
}

export function eligibleForLocalCoding(task: TaskSpec, capability?: Capability, maxDifficulty?: number): boolean {
  task = normalizeTaskSemantics(task, capability);
  if (capability !== "local-coding" || task.category !== "coding" || !task.repository || task.risk === "high") return false;
  return task.difficulty <= (maxDifficulty ?? localCodingMaxDifficulty());
}

// Pure policy. Readiness is supplied by the executor, never by the planner.
export function routeCapability(task: TaskSpec, capability: Capability | undefined,
  availability: ProviderAvailability, maxDifficulty?: number): CapabilityRoute {
  task = normalizeTaskSemantics(task, capability);
  const localLimit = maxDifficulty ?? (capability === "local-coding" && task.category === "coding" && task.repository && task.risk !== "high"
    ? localCodingMaxDifficulty() : 2);
  if (!Number.isInteger(localLimit) || localLimit < 1 || localLimit > 3) throw new Error("Invalid local difficulty policy.");
  let route = routeTask(task);
  let fallbackReason: string | null = null;
  if (capability !== undefined) {
    if (task.category === "coding") {
      if (eligibleForLocalCoding(task, capability, localLimit)) {
        if (availability.opencode.available) route = { worker: "opencode", reason: "Eligible local coding recommendation." };
        else fallbackReason = `OpenCode unavailable before execution: ${availability.opencode.reason ?? "readiness failed"}`;
      } else if (capability !== "strong-coding") {
        fallbackReason = task.risk === "high" || task.difficulty > localLimit ? "Coding risk/difficulty requires Codex." :
          "Coding category overrides incompatible capability.";
      }
    } else if (capability === "strong-general") {
      route = { worker: "antigravity", tier: "pro", reason: "Strong general capability." };
    } else if (capability === "research") {
      route = { worker: "antigravity", tier: route.tier ?? "flash", reason: "Research capability." };
    } else {
      fallbackReason = capability === "independent-review" ? "Independent review is deferred; use existing category route." :
        capability === "local-utility" ? "No local utility execution adapter; use existing category route." :
        "Use existing category route.";
    }
  }
  if (!availability[route.worker].available) throw new Error(`Selected worker ${route.worker} unavailable: ${availability[route.worker].reason ?? "unavailable"}`);
  return { route, metadata: { requestedCapability: capability ?? null, selectedWorker: route.worker,
    fallbackReason, model: availability[route.worker].model ?? null, reason: route.reason } };
}
