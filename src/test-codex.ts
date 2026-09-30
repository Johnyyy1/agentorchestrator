import { runCodex } from "./workers/codex.js";

const result = await runCodex(
  "Reply exactly with: CODEX_WORKER_OK",
  process.cwd(),
);

console.log(result);