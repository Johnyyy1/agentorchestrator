import { providers } from '../../../lib/server.js';
import { validateLocalRequest } from '../../../../../src/control-plane/security.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    validateLocalRequest(request);
    return Response.json(await providers(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'System status is unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
