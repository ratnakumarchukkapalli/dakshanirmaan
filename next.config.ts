import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Security headers that do not vary per request. The nonce-based CSP is set in
// src/proxy.ts because it needs a fresh nonce on every request.
const staticSecurityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The invoice PDF reads its fonts from disk at request time; tell the file tracer to ship them.
  outputFileTracingIncludes: { '/api/invoices/[id]/pdf': ['./src/assets/fonts/**'] },
  async headers() {
    return [{ source: '/:path*', headers: staticSecurityHeaders }];
  },
};

export default withNextIntl(nextConfig);
