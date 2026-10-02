import { z } from 'zod';
import { MEMORY_CONTENT_LIMIT, RETRIEVAL_LIMIT } from '../memory/constants.js';
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => text(max).nullable().optional();
export const projectStatusSchema = z.enum(['active', 'paused', 'archived']);
export const bindingInputSchema = z.strictObject({ repositoryId: z.uuid(), role: optionalText(100), isPrimary: z.boolean().default(false) });
const bindings = z.array(bindingInputSchema).max(20).superRefine((rows, ctx) => {
  if (rows.filter(r => r.isPrimary).length > 1) ctx.addIssue({ code: 'custom', message: 'Only one primary repository is allowed.' });
  if (new Set(rows.map(r => r.repositoryId)).size !== rows.length) ctx.addIssue({ code: 'custom', message: 'Duplicate repository binding.' });
});
const fields = { name: text(200), description: optionalText(2000), status: projectStatusSchema.default('active'),
  currentMilestone: optionalText(1000), goals: optionalText(3000), constraints: optionalText(3000), instructions: optionalText(3000) };
export const createProjectSchema = z.strictObject({ ...fields, slug: text(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(), repositories: bindings.default([]) });
export const updateProjectSchema = z.strictObject({ ...fields, repositories: bindings.optional() }).partial();
export const projectDtoSchema = z.object({ id: z.uuid(), slug: text(100), ...fields,
  description: z.string().nullable(), currentMilestone: z.string().nullable(), goals: z.string().nullable(), constraints: z.string().nullable(), instructions: z.string().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  repositories: z.array(z.object({ repositoryId: z.uuid(), key: z.string(), name: z.string(), role: z.string().nullable(), isPrimary: z.boolean() })),
  recentTasks: z.array(z.object({ id: z.uuid(), title: z.string(), status: z.string(), updatedAt: z.iso.datetime() })).max(5),
});
export type ProjectDto = z.infer<typeof projectDtoSchema>;
export const memoryKindSchema = z.enum(['fact', 'decision', 'milestone', 'issue', 'architecture', 'outcome']);
export const sourceTypeSchema = z.enum(['manual', 'task', 'run', 'review', 'task_outcome_sync', 'import']);
// This general schema is for deterministic/internal writers. Browser input has no source authority.
export const memoryInputSchema = z.strictObject({ kind: memoryKindSchema, title: optionalText(200), content: text(MEMORY_CONTENT_LIMIT),
  importance: z.number().int().min(0).max(5).default(2), sourceType: sourceTypeSchema, sourceId: text(200).nullable().optional(),
  sourceMetadata: z.record(z.string(), z.unknown()).nullable().optional().refine(v => JSON.stringify(v ?? {}).length <= 2000, 'Metadata too large.'),
}).superRefine((v, ctx) => { if (v.sourceType !== 'manual' && !v.sourceId) ctx.addIssue({ code: 'custom', message: 'Non-manual provenance requires sourceId.' }); });
export const manualMemorySchema = z.strictObject({ kind: memoryKindSchema, title: optionalText(200), content: text(MEMORY_CONTENT_LIMIT), importance: z.number().int().min(0).max(5).default(2) });
export const searchMemorySchema = z.strictObject({ query: text(4000), limit: z.number().int().min(1).max(RETRIEVAL_LIMIT).default(RETRIEVAL_LIMIT) });
export const memoryDtoSchema = z.object({ id: z.uuid(), projectId: z.uuid(), kind: memoryKindSchema, title: z.string().nullable(), content: z.string(), importance: z.number(),
  sourceType: sourceTypeSchema, sourceId: z.string().nullable(), sourceMetadata: z.record(z.string(), z.unknown()).nullable(), contentHash: z.string(),
  embeddingModel: z.string().nullable(), indexed: z.boolean(), embeddingError: z.string().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export type MemoryDto = z.infer<typeof memoryDtoSchema>;
export const snapshotSchema = z.strictObject({ projectId: z.uuid(), projectUpdatedAt: z.iso.datetime(), memoryIds: z.array(z.uuid()).max(8), recentTaskIds: z.array(z.uuid()).max(5),
  repositoryBinding: z.strictObject({ repositoryId: z.uuid(), role: z.string().max(100).nullable(), isPrimary: z.boolean() }).nullable(),
  retrievalQuery: z.string().min(1).max(4000), retrievalStatus: z.enum(['ok', 'unavailable']), createdAt: z.iso.datetime() });
export type ProjectContextSnapshot = z.infer<typeof snapshotSchema>;
export const submissionContextSchema = z.strictObject({ projectId: z.uuid(), snapshot: snapshotSchema }).refine(v => v.projectId === v.snapshot.projectId, 'Snapshot project mismatch.');
export type ProjectSubmissionContext = z.infer<typeof submissionContextSchema>;
