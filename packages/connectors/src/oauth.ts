/**
 * Wise OAuth 2.0 (authorization code + refresh) against Wise's OAuth endpoints.
 *
 * PermitZero is the OAuth CLIENT (its platform credentials live only in the
 * deployment's environment); the USER authorizes PermitZero against their own
 * Wise account in a browser redirect flow. PermitZero never sees the user's
 * provider password or API keys, and the resulting tokens are handed back to
 * the caller for encrypted-at-rest storage — nothing here persists anything.
 *
 * Endpoints (Wise Platform API):
 *   GET  {authorizeUrl}   — browser redirect
 *   POST {tokenUrl}       — HTTP Basic(client_id, client_secret), form-encoded
 */
export interface WiseOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** e.g. https://api.sandbox.transferwise.tech/oauth/authorize */
  authorizeUrl: string;
  /** e.g. https://api.sandbox.transferwise.tech/oauth/token */
  tokenUrl: string;
  redirectUri: string;
  scopes: readonly string[];
}

export interface ProviderTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string | null;
}

export type FetchLike = typeof fetch;

export class WiseOAuthError extends Error {
  readonly status: number;
  /** `invalid_grant` etc. — terminal; the user must reconnect the account. */
  readonly providerCode: string | null;

  constructor(message: string, status: number, providerCode: string | null) {
    super(message);
    this.name = 'WiseOAuthError';
    this.status = status;
    this.providerCode = providerCode;
  }
}

function authHeader(config: WiseOAuthConfig): string {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64');
  return `Basic ${basic}`;
}

export function buildAuthorizeUrl(config: WiseOAuthConfig, state: string): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  if (config.scopes.length > 0) url.searchParams.set('scope', config.scopes.join(' '));
  return url.toString();
}

async function tokenRequest(
  config: WiseOAuthConfig,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<ProviderTokenResponse> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader(config),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (err) {
    throw new WiseOAuthError(
      `Wise token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      0,
      null,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok) {
    throw new WiseOAuthError(
      'Wise rejected the token request.',
      response.status,
      typeof body?.error === 'string' ? body.error : null,
    );
  }
  if (typeof body?.access_token !== 'string' || typeof body?.expires_in !== 'number') {
    throw new WiseOAuthError('Wise token response was malformed.', response.status, null);
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    // Refresh 60s before the provider's own expiry to dodge clock skew and
    // an in-flight request straddling the boundary.
    expiresAt: new Date(Date.now() + Math.max(0, body.expires_in - 60) * 1000),
    scope: typeof body.scope === 'string' ? body.scope : null,
  };
}

export function exchangeAuthorizationCode(
  config: WiseOAuthConfig,
  code: string,
  fetchImpl: FetchLike,
): Promise<ProviderTokenResponse> {
  return tokenRequest(
    config,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
    },
    fetchImpl,
  );
}

export function refreshAccessToken(
  config: WiseOAuthConfig,
  refreshToken: string,
  fetchImpl: FetchLike,
): Promise<ProviderTokenResponse> {
  return tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);
}
