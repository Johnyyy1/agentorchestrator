import { createHash } from 'node:crypto';
import { z } from 'zod';
import { delegate, answerDecision, abandonDecision, realMutationServices } from '../../../../../../src/control-plane/mutations.js';
import { delegateInputSchema, answerInputSchema, abandonInputSchema } from '../../../../../../src/control-plane/contracts.js';
import { createMutationGate, publicError, readJson, RequestError, validateLocalRequest } from '../../../../../../src/control-plane/security.js';
import { fixtureMode, fixtures } from '../../../../../../src/control-plane/fixtures.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const globalGate = globalThis as typeof globalThis & { jonasControlPlaneGate?: ReturnType<typeof createMutationGate> };
globalGate.jonasControlPlaneGate ??= createMutationGate();
export async function POST(request: Request, { params }: { params: Promise<{ operation: string }> }) {
  const { operation } = await params;
  try {
    validateLocalRequest(request, true);
    if (!['delegate', 'answer', 'abandon'].includes(operation)) throw new RequestError(404, 'Unknown operation.');
    const body = await readJson(request);
    const answerCommand = z.strictObject({ id: z.uuid(), answer: answerInputSchema.shape.answer });
    const value = operation === 'delegate' ? delegateInputSchema.parse(body) : operation === 'abandon' ? abandonInputSchema.parse(body) : answerCommand.parse(body);
    const key = request.headers.get('x-request-id') ?? '';
    const fingerprint = createHash('sha256').update(`${operation}:${JSON.stringify(value)}`).digest('hex');
    const result = await globalGate.jonasControlPlaneGate!(key, fingerprint, operation, async () => {
      const services = fixtureMode() ? fixtures().services : await realMutationServices();
      if (operation === 'delegate') return delegate(value, services);
      if (operation === 'abandon') return abandonDecision(value, services);
      const input = answerCommand.parse(value);
      return answerDecision(input.id, { answer: input.answer }, services);
    });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const failure = publicError(error, operation);
    return Response.json({ error: failure.error }, { status: failure.status, headers: { 'Cache-Control': 'no-store' } });
  }
}
