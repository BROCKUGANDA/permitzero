/**
 * The OAuth callback is unauthenticated by necessity: the signed state is its
 * only proof. That proof must be bound to the browser that started the flow,
 * otherwise a planted redirect can link a victim's provider account into an
 * attacker's tenant.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, freshApp, type ApiFixture } from './helpers.js';

let fixture: ApiFixture | null = null;
const saved = {
  live: process.env['LIVE_FINANCE_ENABLED'],
  id: process.env['WISE_CLIENT_ID'],
  secret: process.env['WISE_CLIENT_SECRET'],
  redirect: process.env['CONNECT_REDIRECT_URI'],
};

afterEach(async () => {
  if (fixture) await closeApp(fixture);
  fixture = null;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Wise OAuth state', () => {
  it('sets an HttpOnly nonce cookie scoped to the callback and refuses a state without it', async () => {
    process.env['LIVE_FINANCE_ENABLED'] = 'true';
    process.env['WISE_CLIENT_ID'] = 'test-client';
    process.env['WISE_CLIENT_SECRET'] = 'test-secret';
    process.env['CONNECT_REDIRECT_URI'] = 'http://localhost:3000/connect/wise/callback';
    fixture = await freshApp();

    const start = await fixture.app.inject({
      method: 'GET',
      url: '/v1/connect/wise/start',
      headers: { authorization: `Bearer ${fixture.ownerToken}` },
    });
    expect(start.statusCode).toBe(302);
    const setCookie = start.headers['set-cookie'];
    expect(String(setCookie)).toContain('pz_oauth_nonce=');
    expect(String(setCookie)).toContain('HttpOnly');
    expect(String(setCookie)).toContain('Path=/connect/wise/callback');

    const location = new URL(String(start.headers['location']));
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();

    const callback = await fixture.app.inject({
      method: 'GET',
      url: `/v1/connect/wise/callback?code=test-code&state=${encodeURIComponent(state!)}`,
    });
    expect(callback.statusCode).toBe(403);
  });
});
