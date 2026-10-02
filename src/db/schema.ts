import { sql } from 'drizzle-orm';
import { EMBEDDING_DIMENSION } from '../memory/constants.js';
import type { ProjectContextSnapshot } from '../projects/contracts.js';
import {
    boolean,
    check,
    vector,
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

    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    projectContext: jsonb("project_context").$type<ProjectContextSnapshot>(),
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
  }, t => [index('tasks_project_updated').on(t.projectId, t.updatedAt.desc(), t.id.desc()),
    check('tasks_project_context_check', sql`(${t.projectId} is null and ${t.projectContext} is null) or
      (${t.projectId} is not null and ${t.projectContext} is not null and (${t.projectContext}->>'projectId'=${t.projectId}::text) is true and length(${t.projectContext}::text)<=12000)`)]);

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

// Repository Registry owns filesystem identity independently of projects.
export const repositories = pgTable("repositories", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("repositories_path_unique").on(table.path)]);

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(), slug: text('slug').notNull(), name: text('name').notNull(),
  description: text('description'), status: text('status').notNull().default('active'), currentMilestone: text('current_milestone'),
  goals: text('goals'), constraints: text('constraints'), instructions: text('instructions'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('projects_slug_unique').on(t.slug),
  check('projects_status_check', sql`${t.status} in ('active','paused','archived')`),
  check('projects_lengths_check', sql`length(${t.name}) between 1 and 200 and length(${t.slug}) between 1 and 100
    and coalesce(length(${t.description}),0) <= 2000 and coalesce(length(${t.currentMilestone}),0) <= 1000
    and coalesce(length(${t.goals}),0) <= 3000 and coalesce(length(${t.constraints}),0) <= 3000 and coalesce(length(${t.instructions}),0) <= 3000`)]);
export const projectRepositories = pgTable('project_repositories', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  repositoryId: uuid('repository_id').notNull().references(() => repositories.id, { onDelete: 'restrict' }),
  role: text('role'), isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('project_repositories_pair_unique').on(t.projectId, t.repositoryId),
  uniqueIndex('project_repositories_primary_unique').on(t.projectId).where(sql`${t.isPrimary}`),
  index('project_repositories_repository').on(t.repositoryId), check('project_repositories_role_length', sql`coalesce(length(${t.role}),0) <= 100`)]);
export const projectMemories = pgTable('project_memories', {
  id: uuid('id').defaultRandom().primaryKey(), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), title: text('title'), content: text('content').notNull(), importance: integer('importance').notNull().default(2),
  sourceType: text('source_type').notNull(), sourceId: text('source_id'), sourceMetadata: jsonb('source_metadata'), contentHash: text('content_hash').notNull(),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSION }), embeddingModel: text('embedding_model'), embeddingError: text('embedding_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, t => [index('project_memories_project').on(t.projectId, t.createdAt),
  uniqueIndex('project_memories_duplicate_unique').on(t.projectId, t.sourceType, t.contentHash),
  uniqueIndex('project_memories_outcome_unique').on(t.projectId, t.sourceId).where(sql`${t.sourceType} = 'task_outcome_sync'`),
  check('project_memories_kind_check', sql`${t.kind} in ('fact','decision','milestone','issue','architecture','outcome')`),
  check('project_memories_provenance_check', sql`${t.sourceType} in ('manual','task','run','review','task_outcome_sync','import') and (${t.sourceType} = 'manual' or ${t.sourceId} is not null)`),
  check('project_memories_importance_check', sql`${t.importance} between 0 and 5`),
  check('project_memories_content_check', sql`length(${t.content}) between 1 and 8000 and coalesce(length(${t.title}),0) <= 200 and coalesce(length(${t.sourceId}),0) <= 200`),
  check('project_memories_embedding_check', sql`(${t.embedding} is null and ${t.embeddingModel} is null) or (${t.embedding} is not null and ${t.embeddingModel} is not null)`)]);
