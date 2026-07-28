import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/api';

const DEV_BEARER = process.env['DEV_API_BEARER_TOKEN'];

/**
 * The API's connect endpoint is authenticated (@RequirePermission) and issues
 * a redirect straight to Zoho's consent screen. A browser's top-level
 * navigation cannot carry a custom Authorization header, so this route
 * fetches that redirect server-side — where the dev bearer token can be
 * attached, same as every Server Action in this app — and re-issues it to
 * the browser as a plain redirect to accounts.zoho.com, which needs none.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!brandId) {
    return NextResponse.redirect(new URL('/settings/zoho?error=missing_brand', request.url));
  }

  const upstream = await fetch(`${API_URL}/brands/${brandId}/integrations/zoho/connect`, {
    headers: DEV_BEARER ? { Authorization: `Bearer ${DEV_BEARER}` } : {},
    redirect: 'manual',
  });

  const location = upstream.headers.get('location');
  if (!location) {
    return NextResponse.redirect(
      new URL(`/settings/zoho?brandId=${brandId}&error=connect_failed`, request.url),
    );
  }
  return NextResponse.redirect(location);
}
