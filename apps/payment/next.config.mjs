/**
 * Public payment application.
 *
 * Separate deployment from the admin app (ADR-002): different availability
 * target, different attack surface, different release cadence. An admin deploy
 * cannot take down the payment path, and this app's dependency tree stays small
 * enough to keep it inside PCI SAQ A scope.
 *
 * @type {import('next').NextConfig}
 */

// TDD-001 §15.3. The gateway origin is the ONLY third party permitted, and it
// is added from configuration rather than hard-coded, so a gateway change is a
// deployment variable and not a code change.
const gatewayOrigin = process.env.NEXT_PUBLIC_GATEWAY_ORIGIN ?? '';
const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  `script-src 'self'${gatewayOrigin ? ` ${gatewayOrigin}` : ''}${isDev ? " 'unsafe-eval'" : ''}`,
  // Next injects a style element for critical CSS; 'unsafe-inline' for styles
  // carries none of the script risk and is the documented trade-off.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${apiOrigin}${gatewayOrigin ? ` ${gatewayOrigin}` : ''}${isDev ? ' ws: wss:' : ''}`,
  `frame-src ${gatewayOrigin || "'none'"}`,
  'upgrade-insecure-requests',
].join('; ');

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@fenwick/shared'],

  // No build id derived from source paths, no source maps in production: the
  // payment bundle should reveal as little about internals as possible.
  productionBrowserSourceMaps: false,
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // A payment page must never be cached by a shared proxy.
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
        ],
      },
    ];
  },
};

export default nextConfig;
