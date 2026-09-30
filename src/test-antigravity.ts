import { runAntigravity } from "./workers/antigravity.js";

const result = await runAntigravity(
  "Reply exactly with: ANTIGRAVITY_WORKER_OK",
  process.cwd(),
);

console.log(result);