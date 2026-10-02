import { projectApi } from '../../../../../../src/control-plane/project-api.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handler(request: Request, { params }: { params: Promise<{ id: string }> }) { return projectApi(request, await params); }
export const GET = handler;
export const PATCH = handler;
