import { setTimeout as delay } from "node:timers/promises";
import { pool } from "../db/index.js";
import { boss } from "../queue/boss.js";
import { registerTaskWorker } from "../queue/task-worker.js";

// This separate process always uses a fake executor and an isolated test queue.
const queueName = process.env.QUEUE_TEST_NAME;
if (!queueName?.startsWith("jonas-os.tasks.execute.test.")) {
  throw new Error("Queue test worker requires an isolated QUEUE_TEST_NAME.");
}

let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  stopping ??= (async () => {
    try { await boss.stop({ graceful: true, timeout: 5000 }); }
    finally { await pool.end(); }
  })();
  return stopping;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void stop().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  }); });
}

try {
  await registerTaskWorker({
    queueName,
    executor: async (task) => {
      if (task.title === "Queue thrown failure") throw new Error("QUEUE_TEST_THROWN_ERROR");
      if (task.title === "Queue reported failure") {
        return { workerResult: { success: false, exitCode: 1, stderr: "QUEUE_TEST_REPORTED_ERROR" } };
      }
      if (task.title === "Queue shutdown test") await delay(500);
      return { success: true, message: "QUEUE_TEST_OK" };
    },
  });
  console.log("QUEUE_TEST_WORKER_READY");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await stop();
}
