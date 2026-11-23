/**
 * The sink boundary: a delivered notification must never be delivered twice,
 * but a failed one must remain retryable. Idempotency is keyed by tenant AND
 * delivery id so one tenant cannot reuse another's receipt.
 */
import { describe, expect, it } from 'vitest';
import { HttpNotificationSink, MemoryNotificationSink, type NotificationRequest } from '../src/notification-sink.js';

const BASE: NotificationRequest = {
  deliveryId: 'del_1',
  destination: 'https://hooks.example.com/notify',
  channel: 'operations',
  message: 'Action is waiting for a decision',
  severity: 'warning',
  tenantId: 'ten_alpha',
  traceId: 'trc_1',
};

function fakeFetch(statuses: number[]): { calls: string[]; impl: typeof fetch } {
  const calls: string[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { delivery_id: string };
    calls.push(body.delivery_id);
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 200;
    return { status, ok: status < 400 } as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('HttpNotificationSink idempotency', () => {
  it('sends once and returns the same receipt for a repeated delivery id', async () => {
    const { calls, impl } = fakeFetch([200]);
    const sink = new HttpNotificationSink({ allowedHosts: ['example.com'], fetchImpl: impl });

    const first = await sink.deliver(BASE);
    const second = await sink.deliver(BASE);

    expect(calls).toEqual(['del_1']);
    expect(first.status).toBe('DELIVERED');
    expect(second).toEqual(first);
  });

  it('collapses concurrent deliveries of the same id into one send', async () => {
    const { calls, impl } = fakeFetch([200]);
    const sink = new HttpNotificationSink({ allowedHosts: ['example.com'], fetchImpl: impl });

    const results = await Promise.all([sink.deliver(BASE), sink.deliver(BASE)]);

    expect(calls).toEqual(['del_1']);
    expect(results[0]).toEqual(results[1]);
  });

  it('sends separately for different ids and for the same id in different tenants', async () => {
    const { calls, impl } = fakeFetch([200]);
    const sink = new HttpNotificationSink({ allowedHosts: ['example.com'], fetchImpl: impl });

    await sink.deliver(BASE);
    await sink.deliver({ ...BASE, deliveryId: 'del_2' });
    await sink.deliver({ ...BASE, tenantId: 'ten_beta' });

    expect(calls).toEqual(['del_1', 'del_2', 'del_1']);
  });

  it('does not cache a retryable failure, so the publisher can retry', async () => {
    const { calls, impl } = fakeFetch([503, 200]);
    const sink = new HttpNotificationSink({ allowedHosts: ['example.com'], fetchImpl: impl });

    const first = await sink.deliver(BASE);
    const second = await sink.deliver(BASE);

    expect(first).toEqual({ status: 'FAILED_RETRYABLE', errorClass: 'HTTP_503' });
    expect(second.status).toBe('DELIVERED');
    expect(calls).toEqual(['del_1', 'del_1']);
  });

  it('does not cache a terminal failure either', async () => {
    const { calls, impl } = fakeFetch([400, 200]);
    const sink = new HttpNotificationSink({ allowedHosts: ['example.com'], fetchImpl: impl });

    expect(await sink.deliver(BASE)).toEqual({ status: 'FAILED_TERMINAL', errorClass: 'HTTP_400' });
    expect((await sink.deliver(BASE)).status).toBe('DELIVERED');
    expect(calls).toEqual(['del_1', 'del_1']);
  });
});

describe('HttpNotificationSink destination safety', () => {
  it('refuses a destination outside the allowlist before any request', async () => {
    const { calls, impl } = fakeFetch([200]);
    const sink = new HttpNotificationSink({ allowedHosts: ['example.com'], fetchImpl: impl });

    expect(await sink.deliver({ ...BASE, destination: 'https://evil.test/hook' })).toEqual({
      status: 'FAILED_TERMINAL',
      errorClass: 'DESTINATION_NOT_ALLOWED',
    });
    expect(calls).toEqual([]);
  });

  it('fails closed on an empty allowlist and on a malformed or non-http destination', async () => {
    const { calls, impl } = fakeFetch([200]);
    const closed = new HttpNotificationSink({ allowedHosts: [], fetchImpl: impl });
    const sink = new HttpNotificationSink({ allowedHosts: ['example.com'], fetchImpl: impl });

    expect(await closed.deliver(BASE)).toMatchObject({ errorClass: 'DESTINATION_NOT_ALLOWED' });
    expect(await sink.deliver({ ...BASE, destination: 'not a url' })).toMatchObject({
      errorClass: 'INVALID_DESTINATION',
    });
    expect(await sink.deliver({ ...BASE, destination: 'file:///etc/passwd' })).toMatchObject({
      errorClass: 'INVALID_DESTINATION_SCHEME',
    });
    expect(calls).toEqual([]);
  });

  it('accepts a subdomain of an allowlisted host', async () => {
    const { calls, impl } = fakeFetch([200]);
    const sink = new HttpNotificationSink({ allowedHosts: ['example.com'], fetchImpl: impl });

    expect((await sink.deliver({ ...BASE, destination: 'https://hooks.eu.example.com/a' })).status).toBe('DELIVERED');
    expect(calls).toHaveLength(1);
  });

  it('refuses a redirect instead of following it off the allowlist', async () => {
    let options: RequestInit | undefined;
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      options = init;
      return new Response(null, { status: 307, headers: { Location: 'https://internal.example.net/secret' } });
    }) as typeof fetch;
    const sink = new HttpNotificationSink({ allowedHosts: ['example.com'], fetchImpl: impl });

    expect(await sink.deliver(BASE)).toMatchObject({
      status: 'FAILED_TERMINAL',
      errorClass: 'REDIRECT_REFUSED',
    });
    expect(options?.redirect).toBe('manual');
  });
});

describe('MemoryNotificationSink', () => {
  it('records a delivery once for a repeated id', async () => {
    const sink = new MemoryNotificationSink();

    await sink.deliver(BASE);
    await sink.deliver(BASE);

    expect(sink.delivered).toHaveLength(1);
  });
});
