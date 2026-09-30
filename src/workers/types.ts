export type TaskCategory =
  | "coding"
  | "research"
  | "planning"
  | "review"
  | "utility";

export type TaskRisk =
  | "low"
  | "medium"
  | "high";

export type TaskSpec = {
  title: string;
  objective: string;

  category: TaskCategory;

  difficulty: 1 | 2 | 3 | 4 | 5;

  risk: TaskRisk;

  context: string[];

  acceptanceCriteria: string[];

  maxAttempts: number;

  repository?: {
    path: string;
    baseBranch?: string | undefined;
  } | undefined;
};

export type WorkerId =
  | "opencode"
  | "codex"
  | "antigravity";

export type WorkerRoute = {
  worker: WorkerId;

  tier?:
    | "flash"
    | "pro";

  reason: string;
};
