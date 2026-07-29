import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/api';

const DEV_BEARER = process.env['DEV_API_BEARER_TOKEN'];

/**
 * The activity feed polls this from the browser every few seconds so a pull
 * in progress is visible without a manual reload. The real API's bearer
 * token is server-only (never shipped to the client bundle), so the browser
 * cannot call it directly — this proxies the one read it needs, the same
 * pattern as the OAuth connect redirect.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!brandId) {
    return NextResponse.json({ message: 'missing brandId' }, { status: 400 });
  }

  const upstream = await fetch(`${API_URL}/brands/${brandId}/integrations/zoho/activity`, {
    headers: DEV_BEARER ? { Authorization: `Bearer ${DEV_BEARER}` } : {},
    cache: 'no-store',
  });
  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
