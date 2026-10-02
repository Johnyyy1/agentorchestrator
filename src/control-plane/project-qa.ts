import type { ChiefDecision } from '../chief/schema.js';
// Explicit development-only browser QA: validate/render real DB context, return clarification,
// and never create a queue job or call Chief. Production refuses to start with this flag.
export function projectQaMode() {
  const enabled = process.env.CONTROL_PLANE_PROJECT_QA === '1';
  if (enabled && process.env.NODE_ENV === 'production') throw new Error('Project QA is disabled in production.');
  return enabled;
}
export async function qaPlan(): Promise<ChiefDecision> {
  return { action: 'ask_human', summary: 'Browser QA accepted the goal and validated its context.', reason: 'Explicit development QA prevents task creation and Chief inference.', humanQuestion: 'QA only: goal accepted; no coding task was created.' };
}
