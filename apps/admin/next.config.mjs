/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The shared package ships compiled CommonJS; transpiling it here keeps the
  // module graph consistent with the app's ESM output.
  transpilePackages: ['@fenwick/shared'],

  // The admin app's CSP is standard rather than strict. The payment app's is
  // not — see apps/payment/next.config.mjs and TDD-001 §3.3. A third-party
  // script here is a product decision; there it is a compliance breach.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
