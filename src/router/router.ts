import type {
    TaskSpec,
    WorkerRoute,
  } from "../workers/types.js";

  export function routeTask(
    task: TaskSpec,
  ): WorkerRoute {
    // Repository/code modification belongs to Codex.
    if (task.category === "coding") {
      return {
        worker: "codex",
        reason:
          "Coding task: use the dedicated Codex worker.",
      };
    }

    // Difficult or high-risk non-coding work
    // gets the stronger general-purpose tier.
    if (
      task.difficulty >= 4 ||
      task.risk === "high"
    ) {
      return {
        worker: "antigravity",
        tier: "pro",
        reason:
          "Complex or high-risk general task.",
      };
    }

    // Normal research/planning/review.
    return {
      worker: "antigravity",
      tier: "flash",
      reason:
        "Normal general-purpose task.",
    };
  }
