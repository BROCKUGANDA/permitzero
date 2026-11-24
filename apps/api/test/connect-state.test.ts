/**
 * The PRD's simulation-only boundary means the live OAuth route must not
 * exist, even if a deployment leaves provider credentials in its environment.
 * A dormant route is still a route that can reach a live financial service.
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

describe('simulation-only provider boundary', () => {
  it('does not register the Wise OAuth start route even when provider env is present', async () => {
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
    expect(start.statusCode).toBe(404);
  });
});
