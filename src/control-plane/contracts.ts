import { z } from 'zod';

const text = z.string();
const date = z.iso.datetime();
const nullableText = text.nullable();
export const statuses = ['pending', 'queued', 'running', 'repairing', 'reviewing', 'waiting_human', 'completed', 'failed'] as const;
export const categories = ['coding', 'research', 'planning', 'review', 'utility'] as const;
export const workers = ['opencode', 'codex', 'antigravity'] as const;
export const taskQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  q: text.trim().max(200).default(''),
  status: z.enum([...statuses, 'active', 'attention']).optional(), category: z.enum(categories).optional(),
  worker: z.enum(workers).optional(), project: text.regex(/^[a-f0-9]{24}$/).optional(),
  sort: z.enum(['updated', 'newest', 'status']).default('updated'),
});
export type TaskQuery = z.infer<typeof taskQuerySchema>;
export const projectSchema = z.object({
  key: text, name: text, path: text,
  registered: z.boolean().default(false), available: z.boolean().default(false), unavailableReason: nullableText.default(null),
  running: z.number(), queued: z.number(), waiting: z.number(), failed: z.number(), completed: z.number(), total: z.number(),
  updatedAt: date, latestStatus: text,
});
export type ProjectDto = z.infer<typeof projectSchema>;
export const taskItemSchema = z.object({
  id: z.uuid(), title: text, status: text, category: text,
  projectKey: nullableText, projectName: nullableText,
  capability: nullableText, worker: nullableText, attempt: z.number(),
  createdAt: date, updatedAt: date, startedAt: date.nullable(),
});
export type TaskListItemDto = z.infer<typeof taskItemSchema>;
export const taskListSchema = z.object({ items: z.array(taskItemSchema), total: z.number(), page: z.number(), pageSize: z.number() });
export type TaskListDto = z.infer<typeof taskListSchema>;
export const escalationSchema = z.object({
  id: z.uuid(), taskId: z.uuid(), runId: nullableText, taskTitle: text, taskStatus: text,
  projectName: nullableText, status: text, reasonType: text, question: text, summary: text,
  answer: nullableText, createdAt: date, resolvedAt: date.nullable(),
});
export type EscalationDto = z.infer<typeof escalationSchema>;
export const activitySchema = z.object({
  id: text, taskId: z.uuid(), runId: nullableText, taskTitle: text, kind: text, title: text, detail: text, at: date,
});
export type ActivityEventDto = z.infer<typeof activitySchema>;
export const activityListSchema = z.object({ items: z.array(activitySchema), page: z.number(), hasMore: z.boolean() });
export const overviewSchema = z.object({
  counts: z.object({ running: z.number(), queued: z.number(), waiting: z.number(), failed: z.number(), pending: z.number() }),
  active: z.array(taskItemSchema), queued: z.array(taskItemSchema), failures: z.array(taskItemSchema),
  decisions: z.array(escalationSchema), activity: z.array(activitySchema),
});
export type OverviewDto = z.infer<typeof overviewSchema>;
export const checkSchema = z.object({
  name: text, command: nullableText, status: z.enum(['pass', 'fail', 'skipped', 'timeout']), durationMs: z.number(),
  output: text, outputTruncated: z.boolean(), exitCode: z.number().nullable(),
});
export const runSchema = z.object({
  id: z.uuid(), attempt: z.number(), worker: text, tier: nullableText, status: text,
  capability: nullableText, selectedWorker: nullableText, model: nullableText, fallbackReason: nullableText, routeReason: nullableText,
  failureKind: nullableText, parentRunId: nullableText, startedAt: date, finishedAt: date.nullable(),
  error: nullableText, message: text, messageTruncated: z.boolean(), workerSucceeded: z.boolean().nullable(),
  workspace: z.object({ path: text, branch: text, baseBranch: text, baseCommit: text }).nullable(),
  git: z.object({ changedFiles: z.array(text), changedFileCount: z.number().int().nonnegative(), countIsLowerBound: z.boolean(), statusShort: text, diffStat: text, truncated: z.boolean() }).nullable(),
  checks: z.array(checkSchema),
});
export type RunDto = z.infer<typeof runSchema>;
export const findingDtoSchema = z.object({
  file: nullableText, line: z.number().nullable(), category: text, description: text, reason: text, suggestedFix: nullableText,
});
export const reviewDtoSchema = z.object({
  id: z.uuid(), runId: z.uuid(), reviewer: text, provider: text, model: nullableText, status: text,
  decision: nullableText, severity: nullableText, summary: text, error: nullableText,
  findings: z.array(findingDtoSchema), createdAt: date, finishedAt: date.nullable(),
});
export type ReviewDto = z.infer<typeof reviewDtoSchema>;
export const timelineSchema = z.object({ id: text, kind: text, title: text, detail: text, at: date, ref: nullableText });
export type TimelineEventDto = z.infer<typeof timelineSchema>;
export const taskDetailSchema = z.object({
  task: taskItemSchema.extend({ objective: text, acceptanceCriteria: z.array(text), context: z.array(text),
    repository: nullableText, risk: text, difficulty: z.number(), maxAttempts: z.number(), textTruncated: z.boolean() }),
  runs: z.array(runSchema), reviews: z.array(reviewDtoSchema), decisions: z.array(escalationSchema),
  timeline: z.array(timelineSchema), historyTruncated: z.boolean(),
});
export type TaskDetailDto = z.infer<typeof taskDetailSchema>;
export const providerSchema = z.object({
  id: text, name: text, provider: text, model: nullableText, status: z.enum(['available', 'unavailable', 'unknown']),
  reason: text, checkedAt: date, recentRuns: z.number(), successes: z.number(), failures: z.number(),
  lastSuccess: date.nullable(), lastFailure: date.nullable(), statsNote: text,
});
export type ProviderStatusDto = z.infer<typeof providerSchema>;
export const delegateInputSchema = z.strictObject({ goal: text.trim().min(1).max(4000), projectKey: text.regex(/^[a-f0-9]{24}$/).optional() });
export const delegateResultSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create_task'), taskId: z.uuid(), title: text, capability: text, status: text, summary: text }),
  z.object({ action: z.literal('ask_human'), question: text, summary: text }),
  z.object({ action: z.literal('no_action'), reason: text }),
]);
export type DelegateResultDto = z.infer<typeof delegateResultSchema>;
export const answerInputSchema = z.strictObject({ answer: text.trim().min(1).max(6000) });
export const abandonInputSchema = z.strictObject({ taskId: z.uuid(), confirmed: z.literal(true) });

export const registerRepositoryInputSchema = z.strictObject({ path: text.trim().min(1).max(4096) });
export const registeredRepositorySchema = z.object({ id: z.uuid(), key: text, name: text, path: text });
