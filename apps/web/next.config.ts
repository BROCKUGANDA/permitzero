import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Containers run `node server.js` from the traced standalone bundle, so the
  // web image carries no dev dependencies.
  output: 'standalone',
  // Monorepo: the lockfile lives at the repository root.
  outputFileTracingRoot: path.join(process.cwd(), '..', '..'),
  // E2E drives the dev server over 127.0.0.1 rather than localhost.
  allowedDevOrigins: ['127.0.0.1'],
  // Workspace sources ship as TypeScript; transpile the linked packages.
  transpilePackages: ['@permitzero/ui', '@permitzero/schemas', '@permitzero/domain'],
  poweredByHeader: false,
  /**
   * Set at the application as well as the edge. Caddy already sends these for
   * public traffic, but the console is also reachable by service name on the
   * compose network, and a container that only has its headers from a proxy in
   * front of it loses every one of them the moment something talks to it
   * directly — which is exactly what a scanner or a confused-deputy SSRF probe
   * does.
   *
   * `Content-Security-Policy` here is deliberately the Next App-Router shape:
   * inline bootstrap scripts and styles are how it ships first paint, so both
   * carry 'unsafe-inline'. Locking script-src to 'self' without nonces breaks
   * hydration, so the honest choice is the CSP the framework can actually satisfy
   * plus frame-ancestors and object-src, which is where the clickjacking and
   * plugin-execution risk lives.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self'",
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
              'upgrade-insecure-requests',
            ].join('; '),
          },
        ],
      },
    ];
  },
  // Security headers are only meaningful over HTTPS in the browser; HSTS itself
  // is set at the edge, for the hostname that terminates TLS.

  async rewrites() {
    // Same-origin API access in development; production fronts both with one host.
    const apiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://127.0.0.1:3100';
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
  webpack(config) {
    // Workspace sources use TypeScript's `.js` → `.ts` import style, which
    // webpack does not resolve on its own. Map it back to source files.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.ts', '.jsx'],
      '.mjs': ['.mts', '.ts', '.mjs'],
      '.cjs': ['.cts', '.ts', '.cjs'],
    };
    return config;
  },
};

export default nextConfig;
