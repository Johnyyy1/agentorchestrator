CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "project_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"importance" integer DEFAULT 2 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"source_metadata" jsonb,
	"content_hash" text NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"embedding_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "project_memories_kind_check" CHECK ("project_memories"."kind" in ('fact','decision','milestone','issue','architecture','outcome')),
	CONSTRAINT "project_memories_provenance_check" CHECK ("project_memories"."source_type" in ('manual','task','run','review','task_outcome_sync','import') and ("project_memories"."source_type" = 'manual' or "project_memories"."source_id" is not null)),
	CONSTRAINT "project_memories_importance_check" CHECK ("project_memories"."importance" between 0 and 5),
	CONSTRAINT "project_memories_content_check" CHECK (length("project_memories"."content") between 1 and 8000 and coalesce(length("project_memories"."title"),0) <= 200 and coalesce(length("project_memories"."source_id"),0) <= 200),
	CONSTRAINT "project_memories_embedding_check" CHECK (("project_memories"."embedding" is null and "project_memories"."embedding_model" is null) or ("project_memories"."embedding" is not null and "project_memories"."embedding_model" is not null))
);
--> statement-breakpoint
CREATE TABLE "project_repositories" (
	"project_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"role" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_repositories_role_length" CHECK (coalesce(length("project_repositories"."role"),0) <= 100)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"current_milestone" text,
	"goals" text,
	"constraints" text,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_status_check" CHECK ("projects"."status" in ('active','paused','archived')),
	CONSTRAINT "projects_lengths_check" CHECK (length("projects"."name") between 1 and 200 and length("projects"."slug") between 1 and 100
    and coalesce(length("projects"."description"),0) <= 2000 and coalesce(length("projects"."current_milestone"),0) <= 1000
    and coalesce(length("projects"."goals"),0) <= 3000 and coalesce(length("projects"."constraints"),0) <= 3000 and coalesce(length("projects"."instructions"),0) <= 3000)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "project_context" jsonb;--> statement-breakpoint
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_memories_project" ON "project_memories" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_memories_duplicate_unique" ON "project_memories" USING btree ("project_id","source_type","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "project_memories_outcome_unique" ON "project_memories" USING btree ("project_id","source_id") WHERE "project_memories"."source_type" = 'task_outcome_sync';--> statement-breakpoint
CREATE UNIQUE INDEX "project_repositories_pair_unique" ON "project_repositories" USING btree ("project_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_repositories_primary_unique" ON "project_repositories" USING btree ("project_id") WHERE "project_repositories"."is_primary";--> statement-breakpoint
CREATE INDEX "project_repositories_repository" ON "project_repositories" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_unique" ON "projects" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX tasks_project_updated ON tasks(project_id,updated_at DESC,id DESC);
--> statement-breakpoint
ALTER TABLE tasks ADD CONSTRAINT tasks_project_context_check CHECK (
  (project_id IS NULL AND project_context IS NULL) OR
  (project_id IS NOT NULL AND project_context IS NOT NULL AND (project_context->>'projectId'=project_id::text) IS TRUE AND length(project_context::text)<=12000));
--> statement-breakpoint
CREATE FUNCTION protect_task_project_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.project_context IS DISTINCT FROM OLD.project_context THEN
    RAISE EXCEPTION 'Task project context is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tasks_project_context_immutable BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION protect_task_project_context();
