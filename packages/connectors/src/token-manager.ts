/**
 * Token lifecycle for OAuth-connected provider accounts.
 *
 * The token material never touches this package's callers: `WiseTokenManager`
 * loads it through the `TokenStore` port (the DB adapter decrypts the stored
 * envelope), refreshes it when it is near expiry, and pushes the new token back
 * through the same port. Everything else in the process sees only an opaque,
 * short-lived access token, and only inside the Authorization header.
 */
import { WiseOAuthError, refreshAccessToken } from './oauth.js';
import type { FetchLike, ProviderTokenResponse, WiseOAuthConfig } from './oauth.js';

export interface ProviderToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string | null;
}

/**
 * Persistence port for connected-account tokens. Implementations MUST store the
 * token encrypted at rest (the db adapter uses the `secret-material` key) and
 * MUST scope by tenant; token bytes must never appear in logs or API responses.
 */
export interface TokenStore {
  load(tenantId: string, connectedAccountId: string): Promise<ProviderToken | null>;
  save(tenantId: string, connectedAccountId: string, token: ProviderToken): Promise<void>;
}

/** The connected account has no stored token (never connected, or revoked). */
export class TokenMissingError extends Error {
  readonly connectedAccountId: string;
  constructor(connectedAccountId: string) {
    super(`No stored OAuth token for connected account ${connectedAccountId}.`);
    this.name = 'TokenMissingError';
    this.connectedAccountId = connectedAccountId;
  }
}

/** The provider refused the refresh grant (revoked, expired, re-auth required). */
export class TokenRevokedError extends Error {
  readonly providerCode: string | null;
  constructor(providerCode: string | null) {
    super('The provider rejected the token refresh; the account must be re-connected.');
    this.name = 'TokenRevokedError';
    this.providerCode = providerCode;
  }
}

export interface WiseTokenManagerConfig {
  oauth: WiseOAuthConfig;
  tokenStore: TokenStore;
  fetchImpl?: FetchLike;
  clock?: () => Date;
  /** Refresh when the token expires within this window. Default 120s. */
  refreshLeadMs?: number;
}

export class WiseTokenManager {
  private readonly oauth: WiseOAuthConfig;
  private readonly tokenStore: TokenStore;
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => Date;
  private readonly refreshLeadMs: number;
  /**
   * One refresh per account at a time. Providers rotate refresh tokens: two
   * concurrent refreshes with the same token can leave the account holding a
   * token the provider has already invalidated. The in-flight promise also
   * covers the save, so a caller arriving just after the refresh cannot start
   * a second one before the new token is durable.
   */
  private readonly refreshing = new Map<string, Promise<ProviderTokenResponse>>();

  constructor(config: WiseTokenManagerConfig) {
    this.oauth = config.oauth;
    this.tokenStore = config.tokenStore;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.clock = config.clock ?? (() => new Date());
    this.refreshLeadMs = config.refreshLeadMs ?? 120_000;
  }

  /** Store the token pair returned by the OAuth callback (called by the API). */
  async storeFresh(tenantId: string, connectedAccountId: string, response: ProviderTokenResponse): Promise<void> {
    await this.tokenStore.save(tenantId, connectedAccountId, {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresAt: response.expiresAt,
      scope: response.scope,
    });
  }

  /**
   * A valid access token, refreshing first when needed. Throws
   * `TokenMissingError` (fail closed: nothing to authenticate with) or
   * `TokenRevokedError` (fail closed: the grant died; user must reconnect).
   */
  async accessToken(tenantId: string, connectedAccountId: string): Promise<string> {
    const current = await this.tokenStore.load(tenantId, connectedAccountId);
    if (!current) throw new TokenMissingError(connectedAccountId);
    if (current.expiresAt.getTime() - this.clock().getTime() > this.refreshLeadMs) {
      return current.accessToken;
    }
    if (!current.refreshToken) {
      // No refresh grant stored: the only safe move is to fail closed and ask
      // for a fresh OAuth flow.
      throw new TokenRevokedError('NO_REFRESH_TOKEN');
    }
    const key = `${tenantId}:${connectedAccountId}`;
    let refresh = this.refreshing.get(key);
    if (!refresh) {
      refresh = (async () => {
        let next: ProviderTokenResponse;
        try {
          next = await refreshAccessToken(this.oauth, current.refreshToken!, this.fetchImpl);
        } catch (err) {
          if (err instanceof WiseOAuthError && err.status >= 400 && err.status < 500) {
            // 4xx on refresh means the grant itself is dead — retrying would
            // only hammer the provider with a refused credential.
            throw new TokenRevokedError(err.providerCode);
          }
          throw err; // 5xx/network: retryable at the execution layer.
        }
        await this.tokenStore.save(tenantId, connectedAccountId, {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken ?? current.refreshToken,
          expiresAt: next.expiresAt,
          scope: next.scope,
        });
        return next;
      })();
      this.refreshing.set(key, refresh);
    }

    try {
      const refreshed = await refresh;
      return refreshed.accessToken;
    } finally {
      // Only the promise that owns this refresh removes it. A late caller
      // that arrives after settlement reloads the freshly saved token from
      // the store and never starts a second refresh.
      if (this.refreshing.get(key) === refresh) this.refreshing.delete(key);
    }
  }
}
