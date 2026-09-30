import { pool } from "../db/index.js";
import { boss } from "../queue/boss.js";
import { answerEscalation, listOpenEscalations, abandonTask } from "./service.js";
try {
  const [command, id, answer, ...extra] = process.argv.slice(2);
  if (command === "list" && !id) {
    for (const entry of await listOpenEscalations()) console.log(JSON.stringify({ escalationId: entry.id, taskId: entry.taskId,
      reason: entry.reasonType, question: entry.question, createdAt: entry.createdAt }));
  } else if (command === "answer" && id && answer && extra.length === 0) {
    console.log(JSON.stringify(await answerEscalation(id, answer)));
  } else if (command === "abandon" && id && !answer) {
    await abandonTask(id); console.log(JSON.stringify({ taskId: id, status: "failed", worktree: "retained" }));
  } else throw new Error('Usage: list | answer <escalation-id> "<answer>" | abandon <task-id>');
} catch (error) { console.error(error instanceof Error ? error.message : "Escalation command failed."); process.exitCode = 1; }
finally { try { await boss.stop(); } finally { await pool.end(); } }
