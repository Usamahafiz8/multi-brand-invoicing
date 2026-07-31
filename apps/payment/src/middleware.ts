import { NextResponse, type NextRequest } from 'next/server';

/**
 * The payment app's Content-Security-Policy (TDD-001 §15.3).
 *
 * This lives in middleware rather than next.config's `headers()` because the
 * policy needs a fresh nonce per response. Next's App Router delivers the RSC
 * payload through inline `<script>` tags, so a policy with neither a nonce nor
 * 'unsafe-inline' blocks the page's own hydration data — React then finds no
 * payload, discards the server-rendered markup, and leaves an empty body.
 *
 * A nonce keeps the policy strict where 'unsafe-inline' would not: only the
 * scripts Next itself emits are trusted, and an injected inline script cannot
 * guess the value. That distinction is the reason this app is worth keeping
 * inside PCI SAQ A scope at all.
 *
 * Two CSP headers on one response are enforced as an intersection, so this must
 * remain the only place that sets it.
 */

// The gateway origin is the ONLY third party permitted, and it comes from
// configuration rather than source, so a gateway change is a deployment
// variable and not a code change.
const gatewayOrigin = process.env['NEXT_PUBLIC_GATEWAY_ORIGIN'] ?? '';
const apiOrigin = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';
const isDev = process.env.NODE_ENV !== 'production';

function buildCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // 'self' covers the /_next/static bundles; the nonce covers the inline
    // bootstrap and RSC payload. Dev additionally needs eval for HMR.
    `script-src 'self' 'nonce-${nonce}'${gatewayOrigin ? ` ${gatewayOrigin}` : ''}${
      isDev ? " 'unsafe-eval'" : ''
    }`,
    // Next injects a style element for critical CSS; 'unsafe-inline' for styles
    // carries none of the script risk and is the documented trade-off. The
    // gateway origin is listed because the hosted-tokenization library fetches
    // its own stylesheet — without it the card fields render unstyled.
    `style-src 'self' 'unsafe-inline'${gatewayOrigin ? ` ${gatewayOrigin}` : ''}`,
    `img-src 'self' data: blob:${gatewayOrigin ? ` ${gatewayOrigin}` : ''}`,
    `font-src 'self'${gatewayOrigin ? ` ${gatewayOrigin}` : ''}`,
    `connect-src 'self' ${apiOrigin}${gatewayOrigin ? ` ${gatewayOrigin}` : ''}${
      isDev ? ' ws: wss:' : ''
    }`,
    `frame-src ${gatewayOrigin || "'none'"}`,
    'upgrade-insecure-requests',
  ].join('; ');
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  // Next reads the nonce back off the *request* CSP header and stamps it onto
  // every script tag it renders — that propagation is why the header has to go
  // on the request as well as the response.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Static assets carry no inline script and need no nonce; the remaining
  // security headers still reach them from next.config.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
