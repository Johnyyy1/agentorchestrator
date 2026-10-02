import { projectApi } from '../../../../../src/control-plane/project-api.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => projectApi(request);
export const POST = (request: Request) => projectApi(request);
