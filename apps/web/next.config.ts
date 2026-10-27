import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Monorepo: the lockfile lives at the repository root.
  outputFileTracingRoot: path.join(process.cwd(), '..', '..'),
  // E2E drives the dev server over 127.0.0.1 rather than localhost.
  allowedDevOrigins: ['127.0.0.1'],
  // Workspace sources ship as TypeScript; transpile the linked packages.
  transpilePackages: ['@permitzero/ui', '@permitzero/schemas', '@permitzero/domain'],
  poweredByHeader: false,
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
