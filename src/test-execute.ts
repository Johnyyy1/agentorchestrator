import { executeTask } from "./workers/execute.js";

const result = await executeTask(
  {
    title: "Test coding worker routing",

    objective:
      "Reply exactly with: EXECUTOR_CODEX_OK",

    category: "coding",

    difficulty: 2,

    risk: "low",

    context: [
      "This is only an orchestration test.",
      "Do not modify any files.",
    ],

    acceptanceCriteria: [
      "Final response contains exactly EXECUTOR_CODEX_OK",
    ],

    maxAttempts: 1,
  },

  process.cwd(),
);

console.dir(result, {
  depth: null,
});