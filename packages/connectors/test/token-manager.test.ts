/**
 * Token refresh is a durability boundary: providers rotate refresh tokens, so
 * two concurrent refreshes of one account are one refresh too many.
 */
import { describe, expect, it } from 'vitest';
import { TokenRevokedError, WiseTokenManager, type TokenStore } from '../src/token-manager.js';
import { TokenMissingError } from '../src/token-manager.js';
import type { ProviderToken } from '../src/token-manager.js';
import type { WiseOAuthConfig } from '../src/oauth.js';

const OAUTH: WiseOAuthConfig = {
  clientId: 'client',
  clientSecret: 'secret',
  authorizeUrl: 'https://api.sandbox.transferwise.tech/oauth/authorize',
  tokenUrl: 'https://api.sandbox.transferwise.tech/oauth/token',
  redirectUri: 'https://console.example.com/callback',
  scopes: ['read'],
};

function storeWith(token: ProviderToken | null): TokenStore & { saves: number } {
  let current = token;
  return {
    saves: 0,
    async load() {
      return current;
    },
    async save(_tenant, _account, next) {
      this.saves += 1;
      current = next;
    },
  };
}

function expiring(overrides: Partial<ProviderToken> = {}): ProviderToken {
  return {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: new Date(Date.now() + 1_000),
    scope: 'read',
    ...overrides,
  };
}

function fakeFetch(status = 200, body: Record<string, unknown> = {}): { calls: number; impl: typeof fetch } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return {
      ok: status < 400,
      status,
      json: async () => ({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
        scope: 'read',
        ...body,
      }),
    } as Response;
  }) as unknown as typeof fetch;
  return {
    get calls() {
      return calls;
    },
    impl,
  };
}

describe('WiseTokenManager', () => {
  it('refreshes once for concurrent callers of the same account', async () => {
    const store = storeWith(expiring());
    const transport = fakeFetch();
    const manager = new WiseTokenManager({ oauth: OAUTH, tokenStore: store, fetchImpl: transport.impl });

    const [a, b, c] = await Promise.all([
      manager.accessToken('ten_1', 'con_1'),
      manager.accessToken('ten_1', 'con_1'),
      manager.accessToken('ten_1', 'con_1'),
    ]);

    expect([a, b, c]).toEqual(['fresh-access', 'fresh-access', 'fresh-access']);
    expect(transport.calls).toBe(1);
    expect(store.saves).toBe(1);
  });

  it('reuses the stored token after a refresh without another request', async () => {
    const store = storeWith(expiring());
    const transport = fakeFetch();
    const manager = new WiseTokenManager({ oauth: OAUTH, tokenStore: store, fetchImpl: transport.impl });

    await manager.accessToken('ten_1', 'con_1');
    expect(await manager.accessToken('ten_1', 'con_1')).toBe('fresh-access');

    expect(transport.calls).toBe(1);
  });

  it('fails closed when there is no token or no refresh grant', async () => {
    const transport = fakeFetch();
    const missing = new WiseTokenManager({ oauth: OAUTH, tokenStore: storeWith(null), fetchImpl: transport.impl });
    const noGrant = new WiseTokenManager({
      oauth: OAUTH,
      tokenStore: storeWith(expiring({ refreshToken: null })),
      fetchImpl: transport.impl,
    });

    await expect(missing.accessToken('ten_1', 'con_1')).rejects.toBeInstanceOf(TokenMissingError);
    await expect(noGrant.accessToken('ten_1', 'con_1')).rejects.toBeInstanceOf(TokenRevokedError);
    expect(transport.calls).toBe(0);
  });

  it('treats a 4xx refresh as a dead grant, not a retryable transport error', async () => {
    const store = storeWith(expiring());
    const transport = fakeFetch(400, { error: 'invalid_grant' });
    const manager = new WiseTokenManager({ oauth: OAUTH, tokenStore: store, fetchImpl: transport.impl });

    await expect(manager.accessToken('ten_1', 'con_1')).rejects.toBeInstanceOf(TokenRevokedError);
    expect(store.saves).toBe(0);
  });

  it('does not share an in-flight refresh across two accounts', async () => {
    const store = storeWith(expiring());
    const transport = fakeFetch();
    const manager = new WiseTokenManager({ oauth: OAUTH, tokenStore: store, fetchImpl: transport.impl });

    await Promise.all([manager.accessToken('ten_1', 'con_1'), manager.accessToken('ten_1', 'con_2')]);

    expect(transport.calls).toBe(2);
  });
});
