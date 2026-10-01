import type { Capability } from "../chief/capabilities.js";
import type { TaskSpec } from "../workers/types.js";

export class TaskSemanticError extends Error {
  constructor(message: string) { super(message); this.name = "TaskSemanticError"; }
}

// Deliberately narrow fallback for explicit file/code mutation clauses. Capability
// is authoritative; repository context alone never implies permission to write.
function explicitMutation(text: string): boolean {
  const clause = text.trim().replace(/^[-*]\s+/, "");
  if (/^(?:do not|don't|never|no|without)\b/i.test(clause)) return false;
  return /^(?:please\s+)?(?:create|add|edit|modify|update|delete|remove|write|fix|refactor|implement)\s+(?:a\s+|an\s+|the\s+)?(?:`?[^\s`]+\.[a-z0-9]+\b|(?:(?:TypeScript\s+)?test|file|files|docs|documentation|code|tests?|feature|component|README)\b)/i.test(clause);
}

export function normalizeTaskSemantics(task: TaskSpec, capability?: Capability): TaskSpec {
  const coding = task.category === "coding" || capability === "local-coding" || capability === "strong-coding" ||
    (task.repository !== undefined && [task.objective, ...task.acceptanceCriteria].some(explicitMutation));
  if (!coding) return task;
  if (!task.repository) throw new TaskSemanticError("Coding tasks require repository context; no execution was authorized.");
  return task.category === "coding" ? task : { ...task, category: "coding" };
}
