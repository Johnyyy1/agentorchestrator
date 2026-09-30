import "dotenv/config";
import { PgBoss } from "pg-boss";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not configured. Set it in .env or the environment before starting the queue.",
  );
}

export const TASK_QUEUE_NAME = "jonas-os.tasks.execute";
export type TaskJob = { taskId: string };

export const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  schedule: false,
});

boss.on("error", (error) => console.error("pg-boss error:", error));

let starting: Promise<PgBoss> | undefined;
boss.on("stopped", () => { starting = undefined; });

export async function startQueue(queueName = TASK_QUEUE_NAME): Promise<void> {
  starting ??= boss.start().catch((error: unknown) => {
    starting = undefined;
    throw error;
  });
  await starting;
  await boss.createQueue(queueName);
}
