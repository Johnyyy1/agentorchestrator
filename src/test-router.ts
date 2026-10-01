import { routeTask } from "./router/router.js";
import type { TaskSpec } from "./workers/types.js";

const tasks: TaskSpec[] = [
  {
    title: "Fix failing portfolio tests",
    objective:
      "Find and fix the failing Portfolio Lab tests.",
    category: "coding",
    difficulty: 4,
    risk: "medium",
    context: [],
    acceptanceCriteria: [
      "Tests pass",
      "Typecheck passes",
    ],
    maxAttempts: 2,
    repository: { path: "/fixture/repo" },
  },

  {
    title: "Research portfolio return methods",
    objective:
      "Compare TWR and money-weighted returns.",
    category: "research",
    difficulty: 2,
    risk: "low",
    context: [],
    acceptanceCriteria: [
      "Explain both methods",
    ],
    maxAttempts: 1,
  },

  {
    title: "Architecture review",
    objective:
      "Review the orchestration architecture.",
    category: "review",
    difficulty: 5,
    risk: "high",
    context: [],
    acceptanceCriteria: [
      "Identify architectural risks",
    ],
    maxAttempts: 1,
  },
];

for (const task of tasks) {
  console.log(
    task.title,
    "→",
    routeTask(task),
  );
}