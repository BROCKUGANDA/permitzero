/**
 * Outbound notifications are privileged consequences. Only administrative
 * users may send them, and a retry must reuse the sink's delivery identity
 * instead of sending a duplicate message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeApp, freshApp, postJson, type ApiFixture } from './helpers.js';

let fixture: ApiFixture | null = null;
afterEach(async () => {
  if (fixture) await closeApp(fixture);
  fixture = null;
  vi.unstubAllGlobals();
});

const BODY = {
  destination: 'https://example.com/notify',
  channel: 'operations',
  message: 'Approval required',
  severity: 'warning',
};

describe('notification route', () => {
  it('refuses an agent credential before any outbound request', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    fixture = await freshApp({ config: { notificationAllowedHosts: ['example.com'] } });

    const res = await postJson(fixture, '/v1/notifications/send', fixture.agentToken, BODY);
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('derives a stable delivery id so an identical retry sends once', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    fixture = await freshApp({ config: { notificationAllowedHosts: ['example.com'] } });

    const first = await postJson(fixture, '/v1/notifications/send', fixture.ownerToken, BODY);
    const retry = await postJson(fixture, '/v1/notifications/send', fixture.ownerToken, BODY);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed caller-supplied idempotency key', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    fixture = await freshApp({ config: { notificationAllowedHosts: ['example.com'] } });

    const res = await fixture.app.inject({
      method: 'POST',
      url: '/v1/notifications/send',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${fixture.ownerToken}`,
        'idempotency-key': 'bad key',
      },
      payload: JSON.stringify(BODY),
    });
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
