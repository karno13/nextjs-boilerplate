import {sourcePageResponse} from '../../../lib/source-page.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function POST(request) {
  return sourcePageResponse(request);
}
