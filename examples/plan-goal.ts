import { readFile } from "node:fs/promises";
import { planGoal } from "../src/chief/chief.js";
import { chiefInputSchema } from "../src/chief/schema.js";
import { submitDecision } from "../src/chief/submit-decision.js";

const args = process.argv.slice(2);
try {
  const inputFile = args[0];
  if (!inputFile || args.length > 2 || (args[1] !== undefined && args[1] !== "--submit")) {
    throw new Error("Usage: npx tsx examples/plan-goal.ts <goal.json> [--submit]");
  }
  const input = chiefInputSchema.parse(JSON.parse(await readFile(inputFile, "utf8")));
  const decision = await planGoal(input);
  console.log(JSON.stringify(decision, null, 2));
  if (args[1] === "--submit") {
    try {
      console.log(JSON.stringify(await submitDecision(decision), null, 2));
    } finally {
      if (decision.action === "create_task") {
        const { boss } = await import("../src/queue/boss.js");
        const { pool } = await import("../src/db/index.js");
        try { await boss.stop({ graceful: true }); }
        finally { await pool.end(); }
      }
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
