import { z } from 'zod';
import { chiefInputSchema, validateDecision, validateGrounding } from '../chief/schema.js';
import type { ChiefInput, ChiefDecision } from '../chief/schema.js';
import type { SubmissionResult } from '../chief/submit-decision.js';
import { abandonInputSchema, answerInputSchema, delegateInputSchema, delegateResultSchema } from './contracts.js';
import { safeText } from './mapping.js';

export type MutationServices = {
  repository: (key: string) => Promise<ChiefInput['project'] | null>;
  plan: (input: ChiefInput) => Promise<ChiefDecision>;
  submit: (decision: ChiefDecision) => Promise<SubmissionResult>;
  answer: (id: string, answer: string) => Promise<{ taskId: string; taskStatus: string; status: string }>;
  abandon: (taskId: string) => Promise<void>;
};
export async function delegate(value: unknown, services: MutationServices) {
  const { goal, projectKey } = delegateInputSchema.parse(value);
  const project = projectKey ? await services.repository(projectKey) : undefined;
  if (projectKey && !project) throw new Error('Project is no longer available.');
  const input = chiefInputSchema.parse({ userGoal: goal, ...(project ? { project } : {}) });
  const decision = validateDecision(await services.plan(input));
  validateGrounding(decision, input);
  if (projectKey && decision.action === 'create_task') {
    const current = await services.repository(projectKey);
    if (!current || current.repositoryPath !== project?.repositoryPath) throw new Error('Project is no longer available.');
  }
  const submitted = await services.submit(decision);
  if (submitted.action === 'create_task') return delegateResultSchema.parse({ action: submitted.action,
    taskId: submitted.task.id, title: safeText(submitted.task.title, 300), capability: submitted.capability,
    status: submitted.task.status, summary: safeText(decision.summary, 1000) });
  if (submitted.action === 'ask_human') return delegateResultSchema.parse({ action: submitted.action, question: safeText(submitted.humanQuestion), summary: safeText(decision.summary, 1000) });
  return delegateResultSchema.parse({ action: 'no_action', reason: safeText(decision.reason, 1000) });
}
export async function answerDecision(id: string, value: unknown, services: MutationServices) {
  z.uuid().parse(id);
  const input = answerInputSchema.parse(value);
  const result = await services.answer(id, input.answer);
  return z.object({ taskId: z.uuid(), taskStatus: z.literal('queued'), status: z.literal('resolved') }).parse(result);
}
export async function abandonDecision(value: unknown, services: MutationServices) {
  const input = abandonInputSchema.parse(value);
  await services.abandon(input.taskId);
  return { taskId: input.taskId, taskStatus: 'failed', status: 'cancelled' };
}
export async function realMutationServices(): Promise<MutationServices> {
  const [{ planGoal }, { submitDecision }, { answerEscalation, abandonTask }, { getRepositoryContext }] = await Promise.all([
    import('../chief/chief.js'), import('../chief/submit-decision.js'), import('../escalations/service.js'), import('./queries.js'),
  ]);
  return { plan: planGoal, submit: submitDecision, answer: answerEscalation, abandon: abandonTask, repository: getRepositoryContext };
}
