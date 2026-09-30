import {
    integer,
    index,
    uniqueIndex,
    jsonb,
    pgTable,
    text,
    timestamp,
    uuid,
  } from "drizzle-orm/pg-core";
import type { OrchestrationState } from "../orchestration/state.js";
import type { ReviewResult } from "../review/schema.js";
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

    queueName: text("queue_name").notNull().default("jonas-os.tasks.execute"),
    orchestration: jsonb("orchestration").$type<OrchestrationState>(),

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

    parentRunId: uuid("parent_run_id"),
    failureKind: text("failure_kind"),

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

export const reviews = pgTable("reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  reviewer: text("reviewer").notNull(), providerFamily: text("provider_family").notNull(), model: text("model"),
  status: text("status").notNull(), result: jsonb("result").$type<ReviewResult>(), error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, table => [uniqueIndex("reviews_run_unique").on(table.runId)]);

export const escalations = pgTable("escalations", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  status: text("status").notNull().default("open"), reasonType: text("reason_type").notNull(),
  question: text("question").notNull(), summary: text("summary").notNull(), context: jsonb("context").notNull(),
  answer: text("answer"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, table => [index("escalations_task_status").on(table.taskId, table.status)]);

export const orchestrationEvents = pgTable("orchestration_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  kind: text("kind").notNull(), data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("orchestration_events_task").on(table.taskId, table.createdAt)]);
