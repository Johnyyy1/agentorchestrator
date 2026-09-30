import { pool } from "./db/index.js";
import { boss, TASK_QUEUE_NAME } from "./queue/boss.js";
import { registerTaskWorker } from "./queue/task-worker.js";

let shutdown: Promise<void> | undefined;
let startup: Promise<string> | undefined;

function stopWorker(reason: string): Promise<void> {
  shutdown ??= (async () => {
    console.log(`Jonas OS worker stopping: ${reason}`);
    try {
      // Finish registration before stopping, including signals received during startup.
      await startup?.catch(() => {});
      // Allow Codex plus four bounded verification commands to finish first.
      await boss.stop({ graceful: true, timeout: 600_000 });
    } finally {
      await pool.end();
    }
    console.log("Jonas OS worker stopped.");
  })();
  return shutdown;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stopWorker(signal).catch((error: unknown) => {
      console.error("Worker shutdown failed:", error);
      process.exitCode = 1;
    });
  });
}

try {
  startup = registerTaskWorker();
  await startup;
  if (!shutdown) console.log(`Jonas OS worker ready; listening on ${TASK_QUEUE_NAME}`);
} catch (error) {
  console.error("Worker startup failed:", error);
  process.exitCode = 1;
  await stopWorker("startup failure");
}
