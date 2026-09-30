import {
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uuid,
  } from "drizzle-orm/pg-core";
import type { TaskSpec } from "../workers/types.js";
import type { TaskWorktree } from "../git/worktree.js";
import type { Recommendation } from "../router/recommendation.js";
import type { RoutingMetadata } from "../router/capability-router.js";

  export const tasks = pgTable("tasks", {
    id: uuid("id")
      .defaultRandom()
      .primaryKey(),

    title: text("title").notNull(),

    objective: text("objective").notNull(),

    category: text("category").notNull(),

    difficulty: integer("difficulty").notNull(),

    risk: text("risk").notNull(),

    context: jsonb("context")
      .$type<string[]>()
      .notNull(),

    acceptanceCriteria: jsonb("acceptance_criteria")
      .$type<string[]>()
      .notNull(),

    maxAttempts: integer("max_attempts")
      .notNull()
      .default(2),

    status: text("status")
      .notNull()
      .default("pending"),

    repository: jsonb("repository").$type<NonNullable<TaskSpec["repository"]>>(),
    chief: jsonb("chief").$type<Recommendation>(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  });

  export const runs = pgTable("runs", {
    id: uuid("id")
      .defaultRandom()
      .primaryKey(),

    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, {
        onDelete: "cascade",
      }),

    attempt: integer("attempt")
      .notNull()
      .default(1),

    worker: text("worker").notNull(),

    tier: text("tier"),

    status: text("status")
      .notNull()
      .default("running"),

    result: jsonb("result"),

    workspace: jsonb("workspace").$type<TaskWorktree>(),
    routing: jsonb("routing").$type<RoutingMetadata>(),

    error: text("error"),

    startedAt: timestamp("started_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    finishedAt: timestamp("finished_at", {
      withTimezone: true,
    }),
  });
