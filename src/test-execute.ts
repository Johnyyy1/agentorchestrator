import { executeTask } from "./workers/execute.js";

const result = await executeTask(
  {
    title: "Test general worker routing",

    objective:
      "Reply exactly with: EXECUTOR_GENERAL_OK",

    category: "utility",

    difficulty: 2,

    risk: "low",

    context: [
      "This is only an orchestration test.",
      "Do not modify any files.",
    ],

    acceptanceCriteria: [
      "Final response contains exactly EXECUTOR_GENERAL_OK",
    ],

    maxAttempts: 1,
  },

  process.cwd(),
);

console.dir(result, {
  depth: null,
});