import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { validateLocalRequest } from '../../src/control-plane/security.js';
export function proxy(request: NextRequest) {
  try { validateLocalRequest(request, request.method !== 'GET' && request.method !== 'HEAD'); }
  catch { return new NextResponse('Local same-origin access only.', { status: 403 }); }
  return NextResponse.next();
}
export const config = { matcher: '/((?!_next/static|_next/image|favicon.ico).*)' };
