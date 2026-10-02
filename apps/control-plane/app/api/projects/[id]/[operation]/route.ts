import { projectApi } from '../../../../../../../src/control-plane/project-api.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ id: string; operation: string }> }) { return projectApi(request, await params); }
