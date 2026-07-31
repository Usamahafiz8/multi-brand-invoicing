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

// TDD-001 §15.3. Content-Security-Policy is NOT set here: it carries a
// per-response nonce, which a static header cannot, so it is built in
// src/middleware.ts instead. Setting it in both places would have the browser
// enforce the intersection of the two and block Next's own inline scripts.

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
