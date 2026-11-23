/**
 * Live-finance wiring from the environment.
 *
 * The deployment opts into real money by naming LIVE_FINANCE_ENABLED=1 plus
 * the platform OAuth client (Wise). The wiring is passed to `createBroker`,
 * which turns it into the broker's fail-closed live guard and the Wise
 * adapter. Absent or disabled means live connectors can never dispatch, no
 * matter what any row or policy says.
 */
import type { LiveFinanceWiring } from './stores.js';

const TRUTHY = ['1', 'true', 'yes', 'on'];

export function liveFinanceWiringFromEnv(env: NodeJS.ProcessEnv = process.env): LiveFinanceWiring | null {
  if (!TRUTHY.includes((env['LIVE_FINANCE_ENABLED'] ?? '').trim().toLowerCase())) return null;
  const clientId = env['WISE_CLIENT_ID'] ?? '';
  const clientSecret = env['WISE_CLIENT_SECRET'] ?? '';
  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new Error('LIVE_FINANCE_ENABLED requires WISE_CLIENT_ID and WISE_CLIENT_SECRET.');
  }
  const base = (env['WISE_API_BASE_URL'] ?? 'https://api.sandbox.transferwise.tech').replace(/\/+$/, '');
  const rawMax = env['LIVE_MAX_AMOUNT_MINOR'] ?? '10000';
  const maxAmountMinor = Number.parseInt(rawMax, 10);
  if (!Number.isInteger(maxAmountMinor) || maxAmountMinor < 1 || maxAmountMinor > 25_000_000) {
    throw new Error('LIVE_MAX_AMOUNT_MINOR must be an integer within 1..25000000 (minor units).');
  }
  const providerTypes = (env['LIVE_PROVIDER_TYPES'] ?? env['LIVE_PROVIDER_TYPE'] ?? 'wise')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (providerTypes.length === 0) providerTypes.push('wise');
  return {
    enabled: true,
    providerTypes,
    maxAmountMinor,
    wiseBaseUrl: base,
    oauth: {
      clientId,
      clientSecret,
      tokenUrl: env['WISE_OAUTH_TOKEN_URL'] ?? `${base}/oauth/token`,
    },
  };
}

/** The OAuth values the CONNECT routes need; null when live finance is off. */
export function connectOAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: readonly string[];
} | null {
  if (!TRUTHY.includes((env['LIVE_FINANCE_ENABLED'] ?? '').trim().toLowerCase())) return null;
  const clientId = env['WISE_CLIENT_ID'] ?? '';
  const clientSecret = env['WISE_CLIENT_SECRET'] ?? '';
  if (clientId.length === 0 || clientSecret.length === 0) return null;
  const redirectUri = env['CONNECT_REDIRECT_URI'] ?? '';
  // The redirect URI is registered with the provider during onboarding; a
  // deployment that forgot it must fail here, not mid-OAuth.
  if (redirectUri.length === 0) {
    throw new Error('LIVE_FINANCE_ENABLED requires CONNECT_REDIRECT_URI (the URL registered with the provider).');
  }
  const base = (env['WISE_API_BASE_URL'] ?? 'https://api.sandbox.transferwise.tech').replace(/\/+$/, '');
  return {
    authorizeUrl: env['WISE_OAUTH_AUTHORIZE_URL'] ?? `${base}/oauth/authorize`,
    tokenUrl: env['WISE_OAUTH_TOKEN_URL'] ?? `${base}/oauth/token`,
    clientId,
    clientSecret,
    redirectUri,
    scopes: (env['WISE_OAUTH_SCOPES'] ?? 'global')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}
