import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { eq, asc } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { tasks, runs, reviews, escalations, orchestrationEvents } from "../db/schema.js";
import { boss, startQueue, TASK_QUEUE_NAME } from "../queue/boss.js";
import { createTask } from "../tasks/create-task.js";
import { answerEscalation, listOpenEscalations, abandonTask } from "../escalations/service.js";
import { orchestrateCodingTask, recoverCodingTasks } from "./service.js";
import type { OrchestrationOptions } from "./service.js";
import { infrastructureFailure, verifierFailureMessage } from "../verification/infrastructure.js";
import { getTaskDetail } from "../control-plane/queries.js";
import { taskOutcome } from "../control-plane/outcome.js";
import { executeTask } from "../workers/execute.js";
import { createTaskWorktree, inspectTaskWorktree, removeTaskWorktree } from "../git/worktree.js";
import type { TaskWorktree } from "../git/worktree.js";
import type { TaskSpec } from "../workers/types.js";
import type { SendOptions } from "pg-boss";
import { processTaskJob } from "../queue/task-worker.js";

const approve = { decision: "approve", summary: "Meets objective", severity: "none", findings: [] };
const changes = { decision: "request_changes", summary: "One material error", severity: "medium", findings: [
  { category: "correctness", file: "value.txt", line: 1, description: "Behavior needs repair", reason: "Acceptance criterion", suggestedFix: "Fix implementation" },
] };
const repair = { action: "repair", summary: "Fix root cause", reason: "Straightforward isolated fix", capability: "local-coding", repairBrief: "Preserve work and fix value.txt; keep tests." };
const ask = { action: "ask_human", summary: "Ambiguity", reason: "Need product decision", humanQuestion: "Which contract is intended?" };

test("durable coding orchestration A–K, safety boundaries and human service", { timeout: 180000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jonas-orchestration-test-")));
  const source = join(root, "source");
  const queueName = `${TASK_QUEUE_NAME}.orchestration-test.${randomUUID()}`;
  const previousRoot = process.env.JONAS_OS_WORKTREE_DIR;
  process.env.JONAS_OS_WORKTREE_DIR = join(root, "worktrees");
  const ids: string[] = [];
  const workspaces = new Map<string, TaskWorktree>();
  const calls = new Map<string, string[]>();
  const reviewerCalls = new Map<string, string[]>();
  const chiefInputs: Array<{ task: string; answers: unknown; review: unknown }> = [];
  let queueCreated = false;
  const git = (args: string[]) => execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: source, timeout: 10000 });
  const spec = (title: string, maxAttempts = 2): TaskSpec => ({ title, objective: "Make value.txt contain ok", category: "coding", difficulty: 1, risk: "low",
    acceptanceCriteria: ["All checks pass and implementation is approved"], context: [], maxAttempts, repository: { path: source } });
  async function create(title: string, maxAttempts = 2) {
    const task = await createTask(spec(title, maxAttempts), queueName, { capability: "local-coding", workerBrief: "Modify only value.txt, preserve tests." });
    ids.push(task.id); return task;
  }
  async function load(id: string) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id)); assert.ok(task);
    return { task, runs: await db.select().from(runs).where(eq(runs.taskId, id)).orderBy(asc(runs.attempt)),
      reviews: await db.select().from(reviews).where(eq(reviews.taskId, id)).orderBy(asc(reviews.createdAt)), escalations: await db.select().from(escalations).where(eq(escalations.taskId, id)).orderBy(asc(escalations.createdAt)),
      events: await db.select().from(orchestrationEvents).where(eq(orchestrationEvents.taskId, id)) };
  }
  function options(title: string, extra: Partial<OrchestrationOptions> = {}): OrchestrationOptions {
    return { cwd: source, chiefModel: "fixture-qwen", executor: async (task, cwd, execution) => {
      const worker = async (name: "opencode" | "codex", path: string, workspace: TaskWorktree) => {
        workspaces.set(workspace.taskId, workspace);
        const list = calls.get(workspace.taskId) ?? []; list.push(name); calls.set(workspace.taskId, list);
        const saved = await load(workspace.taskId); const run = saved.runs.at(-1);
        assert.equal(run?.status, "running"); assert.equal(run?.worker, name); assert.equal(run?.workspace?.path, path);
        assert.equal(saved.task.orchestration?.phase, "executing");
        const bad = title.includes("exhaust") || title.includes("chief") || title.includes("giveup") || title.includes("invalid-chief") || title.includes("resume") || title.includes("verifier") && list.length === 1;
        if (title.includes("resume") && list.length > 1) await writeFile(join(path, "value.txt"), "ok");
        else await writeFile(join(path, "value.txt"), bad ? "bad" : "ok");
        if (title.includes("concurrent")) await delay(100);
        if (title.includes("partial") && list.length === 1) throw new Error("Fixture failure after editing");
        return { success: true, exitCode: 0, message: "Fixture changed value", stderr: "" };
      };
      return executeTask(task, cwd, { ...execution,
        availability: { opencode: { available: true, model: "ollama/fixture-qwen" }, codex: { available: true }, antigravity: { available: true } },
        opencodeExecutor: async (_prompt, path, opts) => ({ ...await worker("opencode", path, opts.workspace), sessionId: "fixture", model: "ollama/fixture-qwen", usage: null, durationMs: 1, timedOut: false, error: null }),
        codexExecutor: async (_prompt, path, opts) => { assert.equal(opts?.mode, "workspace-write"); if (opts?.mode !== "workspace-write") throw new Error("Wrong mode");
          return { ...await worker("codex", path, opts.workspace), threadId: "fixture", usage: null }; },
      });
    }, repair: async input => {
      chiefInputs.push({ task: title, answers: input.humanAnswers, review: input.review });
      assert.ok(input.diff.includes("value.txt"));
      if (title.includes("invalid-chief")) return { ...repair, maxAttempts: 99 };
      if (title.includes("giveup")) return { action: "give_up", summary: "Stop", reason: "Human should inspect retained work" };
      if (title.includes("chief") || title.includes("resume") && input.humanAnswers.length === 0) return ask;
      return title.includes("partial") ? { ...repair, capability: "strong-coding", reason: "Escalate complexity after partial failure" } : repair;
    }, reviewerAvailability: async () => ({ antigravity: { available: true, model: "fixture-google" }, codex: { available: true } }),
    review: async (reviewer, input) => {
      assert.notEqual(reviewer, input.worker); assert.equal(reviewer, "antigravity");
      const list = reviewerCalls.get(title) ?? []; list.push(reviewer); reviewerCalls.set(title, list);
      assert.ok(input.verification.every(check => check.success));
      if (title.includes("review-repair") && list.length === 1) return changes;
      if (title.includes("high")) return { ...changes, severity: "high", findings: [{ ...changes.findings[0], category: "security" }] };
      if (title.includes("review-human")) return { decision: "needs_human", summary: "Unclear contract", severity: "medium", findings: [], humanQuestion: "Which contract should apply?" };
      if (title.includes("invalid-review")) return { ...approve, decision: "approve", severity: "critical" };
      return approve;
    }, ...extra };
  }
  try {
    await mkdir(source); await execa("git", ["init", "-b", "main", source]);
    await writeFile(join(source, "value.txt"), "baseline");
    await writeFile(join(source, "verify.cjs"), "const fs=require('node:fs'), assert=require('node:assert/strict'); if(fs.existsSync('docs/smoke.md')) { assert.equal(fs.readFileSync('value.txt','utf8'),'baseline'); assert.equal(fs.readFileSync('docs/smoke.md','utf8'),'Created by smoke test.\\n'); } else { assert.equal(fs.readFileSync('value.txt','utf8'),'ok'); }\n");
    await writeFile(join(source, "package.json"), JSON.stringify({ scripts: Object.fromEntries(["test", "typecheck", "lint", "build"].map(check => [check, "node verify.cjs"])) }));
    await git(["add", "."]); await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "Fixture baseline"]);
    const head = (await git(["rev-parse", "HEAD"])).stdout;
    await startQueue(queueName); queueCreated = true;
    await t.test("A: initial success requires deterministic checks and independent approval", async () => {
      const task = await create("initial"); await orchestrateCodingTask(task.id, options(task.title));
      const state = await load(task.id); assert.equal(state.task.status, "completed"); assert.equal(state.runs.length, 1); assert.equal(state.reviews[0]?.result?.decision, "approve");
      assert.deepEqual((await boss.findJobs(queueName, { data: { taskId: task.id } }))[0]?.retryLimit, 0);
    });
    await t.test("B: verifier failure repairs the same worktree with distinct persisted runs", async () => {
      const task = await create("verifier"); await orchestrateCodingTask(task.id, options(task.title)); const state = await load(task.id);
      assert.equal(state.task.status, "completed"); assert.equal(state.runs.length, 2); assert.equal(state.runs[0]?.failureKind, "verification");
      assert.equal(state.runs[1]?.parentRunId, state.runs[0]?.id); assert.deepEqual(state.runs[1]?.workspace, state.runs[0]?.workspace);
      assert.equal(state.reviews.length, 1); assert.deepEqual(calls.get(task.id), ["opencode", "opencode"]);
    });
    await t.test("verifier infrastructure retains one attempt and bypasses repair Chief/reviewer even on redelivery and human answer", async () => {
      const task = await create("infra-no-retry", 2); const opts = options(task.title);
      const infrastructure = infrastructureFailure("sandbox", "Local test server could not start inside verifier sandbox. listen EPERM 127.0.0.1");
      const guarded = { ...opts, executor: async (...args: Parameters<NonNullable<OrchestrationOptions['executor']>>) => {
        const output = await opts.executor!(...args);
        return { ...output, success: false, verification: infrastructure, error: verifierFailureMessage(infrastructure) };
      }, repair: async () => { throw new Error("Infrastructure must not call repair Chief"); },
      review: async () => { throw new Error("Infrastructure must not call reviewer"); } };
      await orchestrateCodingTask(task.id, guarded);
      let saved = await load(task.id);
      assert.equal(saved.task.status, "waiting_human"); assert.equal(saved.runs.length, 1);
      assert.equal(saved.runs[0]?.failureKind, "infrastructure"); assert.equal(saved.runs[0]?.attempt, 1);
      assert.equal(saved.escalations[0]?.reasonType, "infrastructure"); assert.equal(saved.reviews.length, 0);
      assert.ok(saved.runs[0]?.workspace); assert.equal(calls.get(task.id)?.length, 1);
      assert.equal(saved.events.some(e => e.kind === "repair_started" || e.kind === "review_started"), false);
      const detail = await getTaskDetail(task.id); assert.ok(detail);
      assert.match(taskOutcome(detail).reason!, /^Verifier infrastructure failure: Local test server/);
      assert.match(taskOutcome(detail).reason!, /listen EPERM 127.0.0.1/);
      assert.ok(taskOutcome(detail).reason!.length < 600);
      await orchestrateCodingTask(task.id, guarded); // settled/redelivered job
      await answerEscalation(saved.escalations[0]!.id, "Infrastructure diagnosed; do not reauthor unchanged code.");
      await orchestrateCodingTask(task.id, guarded);
      saved = await load(task.id);
      assert.equal(saved.task.status, "waiting_human"); assert.equal(saved.runs.length, 1);
      assert.equal(calls.get(task.id)?.length, 1); assert.equal(saved.reviews.length, 0);
      assert.equal(saved.escalations.at(-1)?.reasonType, "infrastructure");
    });
    await t.test("local readiness context mismatch stops before any cloud/local worker invocation", async () => {
      const task = await create("context-mismatch", 2);
      await orchestrateCodingTask(task.id, { cwd: source, executor: (task, cwd, execution) => executeTask(task, cwd, {
        ...execution,
        availability: { opencode: { available: false, model: "ollama/fixture", infrastructure: true, reason: "context_mismatch: explicit model context required" }, codex: { available: true }, antigravity: { available: true } },
        onWorkspaceCreated: async workspace => { workspaces.set(workspace.taskId, workspace); await execution.onWorkspaceCreated?.(workspace); },
        opencodeExecutor: async () => { throw new Error("Must not invoke local worker"); },
        codexExecutor: async () => { throw new Error("Must not invoke cloud fallback"); },
      }), repair: async () => { throw new Error("Must not call repair Chief"); } });
      const saved = await load(task.id);
      assert.equal(saved.task.status, "waiting_human"); assert.equal(saved.runs.length, 1);
      assert.equal(saved.runs[0]?.worker, "opencode"); assert.equal(saved.runs[0]?.failureKind, "infrastructure");
      assert.equal(saved.events.some(e => e.kind === "worker_started"), false);
      assert.equal(saved.escalations[0]?.reasonType, "infrastructure");
      assert.equal(saved.reviews.length, 0); assert.ok(saved.runs[0]?.workspace);
    });
    await t.test("local worker infrastructure bypasses repair/review and remains stopped after redelivery/human answer", async () => {
      const task = await create("local-infra", 2); const opts = options(task.title);
      const guarded = { ...opts, executor: async (...args: Parameters<NonNullable<OrchestrationOptions['executor']>>) => {
        const output = await opts.executor!(...args);
        return { ...output, success: false, failureKind: "infrastructure" as const,
          workerResult: { success: false, failureKind: "infrastructure", error: "OpenCode search executable failed to initialize or execute." },
          error: "OpenCode search executable failed to initialize or execute." };
      }, repair: async () => { throw new Error("Local infrastructure must not invoke repair Chief"); },
      review: async () => { throw new Error("Local infrastructure must not invoke cloud review"); } };
      await orchestrateCodingTask(task.id, guarded);
      let saved = await load(task.id);
      assert.equal(saved.task.status, "waiting_human"); assert.equal(saved.runs.length, 1);
      assert.equal(saved.runs[0]?.failureKind, "infrastructure");
      assert.equal(saved.escalations[0]?.reasonType, "infrastructure"); assert.equal(saved.reviews.length, 0);
      assert.equal(saved.events.some(e => ["repair_started", "review_started"].includes(e.kind)), false);
      await orchestrateCodingTask(task.id, guarded);
      await answerEscalation(saved.escalations[0]!.id, "Inspect infrastructure, preserve the worktree.");
      await orchestrateCodingTask(task.id, guarded); saved = await load(task.id);
      assert.equal(saved.runs.length, 1); assert.equal(calls.get(task.id)?.length, 1);
      assert.equal(saved.task.status, "waiting_human"); assert.equal(saved.reviews.length, 0);
      assert.equal(saved.escalations.at(-1)?.reasonType, "infrastructure");
    });
    await t.test("C: review findings go through Chief, new attempt verifies and reviews again", async () => {
      const task = await create("review-repair"); await orchestrateCodingTask(task.id, options(task.title)); const state = await load(task.id);
      assert.equal(state.task.status, "completed"); assert.equal(state.runs.length, 2); assert.equal(state.reviews.length, 2);
      assert.ok(chiefInputs.find(input => input.task === task.title)?.review);
    });
    await t.test("D: Chief asks a human and re-delivery consumes no additional quota", async () => {
      const task = await create("chief-human"); const opts = options(task.title); await orchestrateCodingTask(task.id, opts); await orchestrateCodingTask(task.id, opts);
      const state = await load(task.id); assert.equal(state.task.status, "waiting_human"); assert.equal(state.escalations[0]?.status, "open"); assert.equal(calls.get(task.id)?.length, 1);
      assert.ok((await listOpenEscalations()).some(entry => entry.taskId === task.id));
    });
    await t.test("E: reviewer needs_human stops execution", async () => {
      const task = await create("review-human"); await orchestrateCodingTask(task.id, options(task.title)); const state = await load(task.id);
      assert.equal(state.task.status, "waiting_human"); assert.equal(state.escalations[0]?.reasonType, "review"); assert.equal(state.runs.length, 1);
    });
    await t.test("F: exhaustion stops before Chief/reviewer/worker can spend again", async () => {
      const task = await create("exhaust", 2); await orchestrateCodingTask(task.id, options(task.title)); const state = await load(task.id);
      assert.equal(state.task.status, "waiting_human"); assert.equal(state.escalations[0]?.reasonType, "max_attempts"); assert.equal(state.runs.length, 2); assert.equal(state.reviews.length, 0);
      assert.equal(chiefInputs.filter(input => input.task === task.title).length, 1);
      const answer = await answerEscalation(state.escalations[0]!.id, "Inspect the work, no cap override."); assert.equal(answer.taskStatus, "queued");
      await orchestrateCodingTask(task.id, options(task.title)); assert.equal((await load(task.id)).runs.length, 2);
      assert.equal((await load(task.id)).task.maxAttempts, 2);
      await abandonTask(task.id); assert.equal((await load(task.id)).task.status, "failed");
    });
    await t.test("G: human answer atomically resolves/requeues; Chief interprets it before same-worktree repair", async () => {
      const task = await create("resume"); const opts = options(task.title); await orchestrateCodingTask(task.id, opts); const before = await load(task.id);
      const entry = before.escalations[0]!;
      await assert.rejects(answerEscalation(entry.id, " "));
      const originalSend = boss.send.bind(boss);
      const jobsBefore = (await boss.findJobs(queueName, { data: { taskId: task.id } })).length;
      const failedEnqueue = mock.method(boss, "send", async (name: string, data: object, sendOptions: SendOptions) => {
        await originalSend(name, data, sendOptions); throw new Error("RESUME_TRANSACTION_FIXTURE");
      });
      try { await assert.rejects(answerEscalation(entry.id, "Must roll back"), /RESUME_TRANSACTION_FIXTURE/); }
      finally { failedEnqueue.mock.restore(); }
      const rolledBack = await load(task.id); assert.equal(rolledBack.task.status, "waiting_human");
      assert.equal(rolledBack.escalations[0]?.answer, null); assert.equal(rolledBack.escalations[0]?.status, "open");
      assert.equal((await boss.findJobs(queueName, { data: { taskId: task.id } })).length, jobsBefore);
      const answered = await answerEscalation(entry.id, "Keep existing API; value should be ok. $(touch NEVER) is task data."); assert.equal(answered.taskStatus, "queued");
      await assert.rejects(answerEscalation(entry.id, "duplicate"), /not open/);
      await orchestrateCodingTask(task.id, opts); const after = await load(task.id);
      assert.equal(after.task.status, "completed"); assert.equal(after.escalations[0]?.status, "resolved"); assert.ok(after.escalations[0]?.answer?.includes("task data"));
      assert.deepEqual(after.runs[1]?.workspace, before.runs[0]?.workspace); assert.ok(JSON.stringify(chiefInputs.filter(input => input.task === task.title)).includes("Keep existing API"));
    });
    await t.test("H: Codex author uses Antigravity; no downgrade after strong repair", async () => {
      const task = await create("partial"); await orchestrateCodingTask(task.id, options(task.title)); const state = await load(task.id);
      assert.equal(state.task.status, "completed"); assert.deepEqual(calls.get(task.id), ["opencode", "codex"]); assert.equal(state.reviews[0]?.reviewer, "antigravity");
      assert.equal(state.runs[0]?.status, "failed"); assert.equal(state.runs[0]?.failureKind, "execution"); assert.deepEqual(state.runs[0]?.workspace, state.runs[1]?.workspace);
      assert.ok(state.events.some(event => event.kind === "repair_authorized"));
    });
    await t.test("I: no reviewer escalates; unavailable preferred reviewer falls back before inference", async () => {
      const task = await create("unavailable"); await orchestrateCodingTask(task.id, options(task.title, { reviewerAvailability: async () => ({}) }));
      assert.equal((await load(task.id)).task.status, "waiting_human"); assert.equal((await load(task.id)).reviews.length, 0);
      const fallback = await create("fallback"); await orchestrateCodingTask(fallback.id, options(fallback.title, {
        reviewerAvailability: async () => ({ codex: { available: true } }), review: async reviewer => { assert.equal(reviewer, "codex"); return approve; },
      })); assert.equal((await load(fallback.id)).task.status, "completed");
    });
    await t.test("J: restart resumes persisted verified checkpoint without reauthoring, but escalates orphaned paid run", async () => {
      const task = await create("restore"); const opts = options(task.title);
      // Persist exactly the checkpoint a worker would leave after finishing an attempt.
      const [run] = await db.insert(runs).values({ taskId: task.id, attempt: 1, worker: "opencode", status: "running" }).returning(); assert.ok(run);
      await db.update(tasks).set({ status: "running", orchestration: { phase: "executing", latestRunId: run.id } }).where(eq(tasks.id, task.id));
      const output = await opts.executor!(spec(task.title), source, { taskId: task.id,
        onWorkspaceCreated: async workspace => { await db.update(runs).set({ workspace }).where(eq(runs.id, run.id)); },
        onRouteSelected: async (routing, route) => { await db.update(runs).set({ worker: route.worker, routing }).where(eq(runs.id, run.id)); } });
      await db.update(runs).set({ status: "completed", result: output, finishedAt: new Date() }).where(eq(runs.id, run.id));
      await db.update(tasks).set({ orchestration: { phase: "after_attempt", latestRunId: run.id } }).where(eq(tasks.id, task.id));
      const [legacy] = await db.insert(tasks).values({ ...spec("legacy-no-repository"), repository: null, queueName, status: "running" }).returning(); assert.ok(legacy); ids.push(legacy.id);
      await recoverCodingTasks(opts, queueName);
      assert.equal((await load(legacy.id)).task.status, "failed", "Legacy coding without repository fails safely.");
      assert.equal((await load(task.id)).task.status, "completed"); assert.equal(calls.get(task.id)?.length, 1);
      const orphan = await create("orphan"); const workspace = await createTaskWorktree({ path: source }, orphan.id); workspaces.set(orphan.id, workspace);
      const [orphanRun] = await db.insert(runs).values({ taskId: orphan.id, attempt: 1, worker: "codex", status: "running", workspace }).returning(); assert.ok(orphanRun);
      await db.update(tasks).set({ status: "running", orchestration: { phase: "executing", latestRunId: orphanRun.id } }).where(eq(tasks.id, orphan.id));
      await recoverCodingTasks(options(orphan.title, { executor: async () => { throw new Error("Orphan must never re-execute"); } }), queueName);
      const state = await load(orphan.id); assert.equal(state.task.status, "waiting_human"); assert.equal(state.runs.length, 1); assert.equal(state.runs[0]?.failureKind, "interrupted");
      assert.equal(calls.get(orphan.id), undefined);
      const reviewing = await create("orphan-review"); const reviewWorkspace = await createTaskWorktree({ path: source }, reviewing.id); workspaces.set(reviewing.id, reviewWorkspace);
      const [reviewRun] = await db.insert(runs).values({ taskId: reviewing.id, attempt: 1, worker: "codex", status: "completed", workspace: reviewWorkspace }).returning(); assert.ok(reviewRun);
      await db.insert(reviews).values({ taskId: reviewing.id, runId: reviewRun.id, reviewer: "antigravity", providerFamily: "google", status: "running" });
      await db.update(tasks).set({ status: "reviewing", orchestration: { phase: "reviewing", latestRunId: reviewRun.id } }).where(eq(tasks.id, reviewing.id));
      await recoverCodingTasks(options(reviewing.title, { review: async () => { throw new Error("Interrupted review must not repeat"); } }), queueName);
      const interruptedReview = await load(reviewing.id); assert.equal(interruptedReview.task.status, "waiting_human");
      assert.equal(interruptedReview.reviews[0]?.status, "interrupted");
    });
    await t.test("semantic regression enters coding orchestration for new and legacy Chief rows", async () => {
      const input = { ...spec("semantic-regression"), category: "utility" as const, objective: "Create docs/smoke.md",
        acceptanceCriteria: ["docs/smoke.md exists", "No unrelated files changed"] };
      const task = await createTask(input, queueName, { capability: "local-coding", workerBrief: "Inspect and create docs/smoke.md" });
      ids.push(task.id);
      assert.equal(task.category, "coding");
      await db.update(tasks).set({ category: "utility" }).where(eq(tasks.id, task.id)); // pre-fix persisted row
      let workerCalls = 0;
      const opts = options(task.title, { executor: (task, cwd, execution) => executeTask(task, cwd, { ...execution,
        availability: { opencode: { available: true, model: "ollama/fixture-qwen" }, codex: { available: true }, antigravity: { available: true } },
        opencodeExecutor: async (_prompt, path, workerOptions) => {
          workerCalls++;
          workspaces.set(workerOptions.workspace.taskId, workerOptions.workspace);
          await mkdir(join(path, "docs")); await writeFile(join(path, "docs/smoke.md"), "Created by smoke test.\n");
          return { success: true, exitCode: 0, message: null, stderr: "", sessionId: "fixture",
            model: "ollama/fixture-qwen", usage: null, durationMs: 1, timedOut: false, error: null };
        }, codexExecutor: async () => { throw new Error("Semantic regression must use OpenCode"); },
      }) });
      await processTaskJob({ id: randomUUID(), name: queueName, data: { taskId: task.id }, retryCount: 0,
        expireInSeconds: 3600, heartbeatSeconds: null, signal: new AbortController().signal },
        (task, cwd, execution) => { assert.equal(task.category, "coding"); return opts.executor!(task, cwd, execution ?? {}); }, source, opts);
      const saved = await load(task.id);
      assert.equal(saved.task.category, "coding"); assert.equal(saved.task.status, "completed");
      assert.equal(saved.runs[0]?.worker, "opencode"); assert.ok(saved.runs[0]?.workspace);
      assert.equal(saved.reviews[0]?.reviewer, "antigravity"); assert.equal(workerCalls, 1);
      const output = saved.runs[0]!.result as import("../workers/execute.js").ExecutionResult;
      assert.deepEqual(output.git?.changedFiles, ["docs/smoke.md"]);
      assert.equal((output.workerResult as { message: unknown }).message, null);
      assert.equal(await readFile(join(saved.runs[0]!.workspace!.path, "docs/smoke.md"), "utf8"), "Created by smoke test.\n");
    });
    await t.test("successful claims missing verifier, workspace or final review never complete", async () => {
      for (const missing of ["verification", "workspace", "review", "persisted-workspace"] as const) {
        const task = await create(`missing-${missing}`, 1); const opts = options(task.title);
        const [run] = await db.insert(runs).values({ taskId: task.id, worker: "opencode", status: "running" }).returning(); assert.ok(run);
        await db.update(tasks).set({ status: "running", orchestration: { phase: "executing", latestRunId: run.id } }).where(eq(tasks.id, task.id));
        const output = await opts.executor!(spec(task.title, 1), source, { taskId: task.id,
          onWorkspaceCreated: async workspace => { await db.update(runs).set({ workspace }).where(eq(runs.id, run.id)); },
          onRouteSelected: async (routing, route) => { await db.update(runs).set({ routing, worker: route.worker }).where(eq(runs.id, run.id)); } });
        if (missing === "verification") delete output.verification;
        if (missing === "workspace") delete output.workspace;
        await db.update(runs).set({ status: "completed", result: output,
          ...(missing === "persisted-workspace" ? { workspace: null } : {}) }).where(eq(runs.id, run.id));
        if (missing === "persisted-workspace") await db.insert(reviews).values({ taskId: task.id, runId: run.id,
          reviewer: "antigravity", providerFamily: "google", status: "completed", result: { ...approve, decision: "approve", severity: "none" } });
        const reviewed = missing === "review" || missing === "persisted-workspace";
        await db.update(tasks).set({ status: reviewed ? "reviewing" : "running",
          orchestration: { phase: reviewed ? "reviewed" : "after_attempt", latestRunId: run.id } }).where(eq(tasks.id, task.id));
        await orchestrateCodingTask(task.id, { ...opts, review: async () => { throw new Error("Must not review incomplete execution"); } });
        const saved = await load(task.id); assert.equal(saved.task.status, "waiting_human");
        assert.match(saved.escalations[0]!.summary, /Execution incomplete: repository mutation was not verified/);
        assert.equal(saved.runs.length, 1); assert.equal(saved.reviews.length, missing === "persisted-workspace" ? 1 : 0);
      }
    });
    await t.test("general executor cannot complete a repository coding task after a conflicting legacy update", async () => {
      const [task] = await db.insert(tasks).values({ ...spec("legacy-shortcut"), category: "utility", objective: "Summarize status",
        queueName, status: "queued" }).returning(); assert.ok(task); ids.push(task.id);
      await assert.rejects(processTaskJob({ id: randomUUID(), name: queueName, data: { taskId: task.id }, retryCount: 0,
        expireInSeconds: 3600, heartbeatSeconds: null, signal: new AbortController().signal }, async () => {
          await db.update(tasks).set({ chief: { capability: "local-coding", workerBrief: "legacy conflict" } }).where(eq(tasks.id, task.id));
          return { success: true, message: "General worker claimed success" };
        }, source), /Execution incomplete/);
      assert.equal((await load(task.id)).task.status, "failed");
    });
    await t.test("K: concurrent claim and pg-boss redelivery never double-execute a logical attempt", async () => {
      const task = await create("concurrent"); const opts = options(task.title);
      await Promise.all([orchestrateCodingTask(task.id, opts), orchestrateCodingTask(task.id, opts)]);
      await processTaskJob({ id: randomUUID(), name: queueName, data: { taskId: task.id }, retryCount: 9, expireInSeconds: 3600, heartbeatSeconds: null, signal: new AbortController().signal }, (task, cwd, execution) => opts.executor!(task, cwd, execution ?? {}), source, opts);
      assert.equal(calls.get(task.id)?.length, 1); assert.equal((await load(task.id)).runs.length, 1);
    });
    await t.test("high severity, give_up and invalid structured outputs escalate without hidden retries", async () => {
      for (const title of ["high", "giveup", "invalid-chief", "invalid-review"]) {
        const task = await create(title); await orchestrateCodingTask(task.id, options(task.title)); const state = await load(task.id);
        assert.equal(state.task.status, "waiting_human"); assert.equal(state.runs.length, 1); assert.equal(calls.get(task.id)?.length, 1);
        if (title === "high") assert.equal(state.escalations[0]?.reasonType, "security");
      }
    });
    await t.test("incomplete snapshots and worker failures cannot receive review approval", async () => {
      const omitted = await create("omitted"); const opts = options(omitted.title);
      await orchestrateCodingTask(omitted.id, { ...opts, executor: async (task, cwd, execution) => {
        const output = await opts.executor!(task, cwd, execution); assert.ok(output.workspace);
        await writeFile(join(output.workspace.path, ".env"), "FIXTURE_SECRET=example-only");
        output.git = await inspectTaskWorktree(output.workspace); return output;
      } });
      const omittedState = await load(omitted.id); assert.equal(omittedState.task.status, "waiting_human"); assert.equal(omittedState.reviews.length, 0);
      assert.equal(reviewerCalls.get(omitted.title), undefined);
      const failed = await create("worker-failed", 1); const failedOpts = options(failed.title);
      await orchestrateCodingTask(failed.id, { ...failedOpts, executor: async (task, cwd, execution) => {
        const output = await failedOpts.executor!(task, cwd, execution); return { ...output, success: true, workerResult: { success: false } };
      } });
      assert.equal((await load(failed.id)).task.status, "waiting_human"); assert.equal((await load(failed.id)).reviews.length, 0);
    });
    await t.test("older human answers never bypass the cap on a later exhausted review", async () => {
      const task = await create("high-cap"); const opts = options(task.title);
      await orchestrateCodingTask(task.id, opts); const waiting = await load(task.id);
      assert.equal(waiting.task.status, "waiting_human");
      await answerEscalation(waiting.escalations[0]!.id, "Authorize an isolated repair, preserve authorization semantics.");
      await orchestrateCodingTask(task.id, opts); const state = await load(task.id);
      assert.deepEqual(calls.get(task.id), ["opencode", "codex"]);
      assert.equal(state.task.status, "waiting_human"); assert.equal(state.escalations.at(-1)?.reasonType, "max_attempts");
      assert.equal(chiefInputs.filter(input => input.task === task.title).length, 2, "No Chief after the second review exhausts the budget.");
    });
    assert.equal(await readFile(join(source, "value.txt"), "utf8"), "baseline"); assert.equal((await git(["status", "--short"])).stdout, ""); assert.equal((await git(["rev-parse", "HEAD"])).stdout, head);
  } finally {
    try {
      await boss.stop();
      if (queueCreated) { await startQueue(queueName); await boss.deleteQueue(queueName); }
      for (const id of ids) {
        for (const run of (await load(id)).runs) if (run.workspace) workspaces.set(id, run.workspace);
        await db.delete(tasks).where(eq(tasks.id, id));
      }
      for (const workspace of workspaces.values()) await removeTaskWorktree(workspace, { force: true });
      await rm(root, { recursive: true, force: true });
    } finally {
      try { await boss.stop(); } finally { await pool.end(); }
      if (previousRoot === undefined) delete process.env.JONAS_OS_WORKTREE_DIR; else process.env.JONAS_OS_WORKTREE_DIR = previousRoot;
    }
  }
});
