import type { PoolClient } from 'pg';
import type { TaskSpec } from '../workers/types.js';
import { submissionContextSchema } from './contracts.js';
import { RequestError } from '../control-plane/security.js';
// Caller metadata is validated and written atomically with the task, never supplied by the model.
export async function validateProjectSubmission(client: Pick<PoolClient, 'query'>, value: unknown, spec: TaskSpec) {
  const context = submissionContextSchema.parse(value), snapshot = context.snapshot;
  const project = await client.query('select status,updated_at from projects where id=$1 for share', [context.projectId]);
  if (!project.rowCount || project.rows[0].status !== 'active' || new Date(project.rows[0].updated_at).toISOString() !== snapshot.projectUpdatedAt)
    throw new RequestError(409, 'Project changed during planning. Submit the goal again.');
  if (snapshot.repositoryBinding) {
    const bound = await client.query(`select r.path,b.role,b.is_primary from project_repositories b join repositories r on r.id=b.repository_id where b.project_id=$1 and b.repository_id=$2 for share of b,r`, [context.projectId, snapshot.repositoryBinding.repositoryId]);
    if (!bound.rowCount || bound.rows[0].role !== snapshot.repositoryBinding.role || bound.rows[0].is_primary !== snapshot.repositoryBinding.isPrimary || (spec.repository && spec.repository.path !== bound.rows[0].path))
      throw new RequestError(409, 'Project repository binding changed during planning.');
  } else if (spec.repository) throw new RequestError(400, 'Project tasks require a bound repository.');
  const memories = await client.query('select id from project_memories where project_id=$1 and id=any($2::uuid[]) and archived_at is null for share', [context.projectId, snapshot.memoryIds]);
  const recent = await client.query('select id from tasks where project_id=$1 and id=any($2::uuid[]) for share', [context.projectId, snapshot.recentTaskIds]);
  if (memories.rowCount !== new Set(snapshot.memoryIds).size || recent.rowCount !== new Set(snapshot.recentTaskIds).size) throw new RequestError(409, 'Project context changed during planning.');
  return { projectId: context.projectId, projectContext: snapshot };
}
