import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/api';

const DEV_BEARER = process.env['DEV_API_BEARER_TOKEN'];

/** Client-callable proxy for the pull action — same reason as
 * activity/route.ts: the API's bearer token is server-only. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!brandId) return NextResponse.json({ message: 'missing brandId' }, { status: 400 });

  const upstream = await fetch(`${API_URL}/brands/${brandId}/integrations/zoho/pull`, {
    method: 'POST',
    headers: DEV_BEARER ? { Authorization: `Bearer ${DEV_BEARER}` } : {},
  });
  const body = await upstream.text();
  return new NextResponse(body, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
}
