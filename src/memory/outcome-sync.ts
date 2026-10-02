import { z } from 'zod';
import type { TaskDetailDto } from '../control-plane/contracts.js';
import { safeText } from '../control-plane/mapping.js';
import { getTaskDetail } from '../control-plane/queries.js';
import { projectStore } from '../projects/store.js';
import type { ProjectStore } from '../projects/store.js';
export function projectTaskOutcome(detail: TaskDetailDto) {
  if (detail.task.status !== 'completed') return null;
  const run = [...detail.runs].reverse().find(r => r.status === 'completed'), review = [...detail.reviews].reverse().find(r => r.runId === run?.id && r.status === 'completed');
  // Allowlist only public evidence. Never copy run.result, prompts or hidden reasoning.
  const content = [`TASK: ${safeText(detail.task.title, 300)}`, `OBJECTIVE: ${safeText(detail.task.objective, 2500)}`,
    `CHANGED FILES: ${run?.git?.changedFiles.slice(0,20).map(f => safeText(f,150)).join(', ') || '(not recorded)'}`,
    `VERIFICATION: ${run?.checks.slice(0,20).map(c => `${c.name.slice(0,50)}=${c.status}`).join(', ') || '(not recorded)'}`,
    `REVIEW: ${review?.decision ?? '(not recorded)'}`, `PUBLIC SUMMARY: ${safeText(run?.message, 1500) || '(not recorded)'}`].join('\n').slice(0,8000);
  return { kind: 'outcome' as const, title: safeText(detail.task.title,200), content, importance: 2, sourceType: 'task_outcome_sync' as const,
    sourceId: detail.task.id, sourceMetadata: { taskId: detail.task.id, runId: run?.id ?? null, reviewId: review?.id ?? null, projectorVersion: 1 } };
}
export async function syncProjectTaskMemories(projectId: string, options: { store?: ProjectStore; afterTaskId?: string; detail?: typeof getTaskDetail } = {}) {
  z.uuid().parse(projectId); if (options.afterTaskId) z.uuid().parse(options.afterTaskId);
  const store = options.store ?? await projectStore(); await store.requireProject(projectId);
  const rows = await store.pool.query(`select id from tasks where project_id=$1 and status='completed' and ($2::uuid is null or id>$2::uuid) order by id limit 51`, [projectId, options.afterTaskId ?? null]);
  let created = 0, alreadyExisted = 0, embeddingFailures = 0, skipped = 0;
  for (const row of rows.rows.slice(0,50)) {
    const detail = await (options.detail ?? getTaskDetail)(row.id), projection = detail ? projectTaskOutcome(detail) : null;
    if (!projection) { skipped++; continue; }
    const result = await store.insertMemory(projectId, projection);
    if (result.created) created++; else alreadyExisted++;
    if (!result.memory.indexed && !(await store.indexMemory(projectId, result.memory.id)).indexed) embeddingFailures++;
  }
  return { scanned: Math.min(rows.rows.length,50), created, alreadyExisted, embeddingFailures, skipped, nextCursor: rows.rows.length > 50 ? rows.rows[49].id as string : null };
}
