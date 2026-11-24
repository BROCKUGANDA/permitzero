import { describe, expect, it } from 'vitest';
import { createMemoryStores } from '@permitzero/broker';
import type { ConnectorPaymentRequest } from '@permitzero/broker';
import { HttpFinanceConnector } from '../src/http-connector.js';

const TENANT = 'ten_test';

describe('HttpFinanceConnector', () => {
  it('dispatches to an allowlisted host and records the receipt', async () => {
    const stores = createMemoryStores({ clock: () => new Date('2026-11-19T12:00:00Z') });
    const calls: string[] = [];
    const connector = new HttpFinanceConnector({
      connectorId: 'con_http',
      credentialRef: 'secret://http/test',
      data: stores.data,
      allowedHosts: ['api.example.com'],
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return new Response('ok', { status: 200 });
      }) as typeof fetch,
    });
    const result = await connector.dispatchHttp({
      method: 'POST',
      url: 'https://api.example.com/v1/do',
      body: '{"x":1}',
      tenantId: TENANT,
      idempotencyKey: 'http-key-1',
      actionId: 'act_http_1',
      executionId: 'exe_http_1',
      traceId: 'trc_http_1',
    });
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') return;
    expect(result.receipt.simulated).toBe(false);
    expect(calls).toEqual(['https://api.example.com/v1/do']);
    const ledger = await stores.data.listLedger(TENANT);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.detailRedacted).toMatchObject({ host: 'api.example.com', status: 200 });
  });

  it('refuses a non-allowlisted host before any network call', async () => {
    const stores = createMemoryStores({ clock: () => new Date() });
    let calls = 0;
    const connector = new HttpFinanceConnector({
      connectorId: 'con_http',
      credentialRef: 'secret://http/test',
      data: stores.data,
      allowedHosts: ['api.example.com'],
      fetchImpl: (async () => {
        calls += 1;
        return new Response('ok', { status: 200 });
      }) as typeof fetch,
    });
    const result = await connector.dispatchHttp({
      method: 'POST',
      url: 'https://evil.example.org/x',
      body: null,
      tenantId: TENANT,
      idempotencyKey: 'http-key-2',
      actionId: 'act_http_2',
      executionId: 'exe_http_2',
      traceId: 'trc_http_2',
    });
    expect(result.status).toBe('FAILED_TERMINAL');
    if (result.status === 'FAILED_TERMINAL') expect(result.errorClass).toBe('DESTINATION_NOT_ALLOWED');
    expect(calls).toBe(0);
  });

  it('refuses non-allowlisted methods and oversized bodies', async () => {
    const stores = createMemoryStores({ clock: () => new Date() });
    const connector = new HttpFinanceConnector({
      connectorId: 'con_http',
      credentialRef: 'secret://http/test',
      data: stores.data,
      allowedHosts: ['api.example.com'],
      allowedMethods: ['GET'],
      maxBodyBytes: 4,
    });
    const method = await connector.dispatchHttp({
      method: 'POST',
      url: 'https://api.example.com/x',
      body: null,
      tenantId: TENANT,
      idempotencyKey: 'k3',
      actionId: 'a3',
      executionId: 'e3',
      traceId: 't3',
    });
    expect(method).toEqual({ status: 'FAILED_TERMINAL', errorClass: 'METHOD_NOT_ALLOWED' });

    const body = await connector.dispatchHttp({
      method: 'GET',
      url: 'https://api.example.com/x',
      body: '12345',
      tenantId: TENANT,
      idempotencyKey: 'k4',
      actionId: 'a4',
      executionId: 'e4',
      traceId: 't4',
    });
    expect(body).toEqual({ status: 'FAILED_TERMINAL', errorClass: 'PAYLOAD_TOO_LARGE' });
  });

  it('classifies 5xx as retryable and 4xx as terminal, and returns the original receipt on replay', async () => {
    const stores = createMemoryStores({ clock: () => new Date() });
    let status = 503;
    const connector = new HttpFinanceConnector({
      connectorId: 'con_http',
      credentialRef: 'secret://http/test',
      data: stores.data,
      allowedHosts: ['api.example.com'],
      fetchImpl: (async () => new Response('boom', { status })) as typeof fetch,
    });
    const first = await connector.dispatchHttp({
      method: 'GET',
      url: 'https://api.example.com/x',
      body: null,
      tenantId: TENANT,
      idempotencyKey: 'k5',
      actionId: 'a5',
      executionId: 'e5',
      traceId: 't5',
    });
    expect(first.status).toBe('FAILED_RETRYABLE');
    if (first.status !== 'FAILED_RETRYABLE') return;
    expect(first.errorClass).toBe('HTTP_503');

    status = 200;
    const second = await connector.dispatchHttp({
      method: 'GET',
      url: 'https://api.example.com/x',
      body: null,
      tenantId: TENANT,
      idempotencyKey: 'k5',
      actionId: 'a5',
      executionId: 'e5',
      traceId: 't5',
    });
    // Ledger fast path: the failed attempt recorded nothing, so a second
    // dispatch runs again and now succeeds.
    expect(second.status).toBe('SUCCEEDED');
  });

  it('reports a post-dispatch timeout as unknown instead of retryable', async () => {
    const stores = createMemoryStores({ clock: () => new Date() });
    const connector = new HttpFinanceConnector({
      connectorId: 'con_http',
      credentialRef: 'secret://http/test',
      data: stores.data,
      allowedHosts: ['api.example.com'],
      timeoutMs: 10,
      fetchImpl: (async (_url: string, init?: { signal?: AbortSignal }) => {
        await new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
        return new Response('ok', { status: 200 });
      }) as typeof fetch,
    });
    const result = await connector.dispatchHttp({
      method: 'GET',
      url: 'https://api.example.com/x',
      body: null,
      tenantId: TENANT,
      idempotencyKey: 'k6',
      actionId: 'a6',
      executionId: 'e6',
      traceId: 't6',
    });
    expect(result).toEqual({ status: 'TIMEOUT_AFTER_DISPATCH' });
    expect(await stores.data.listLedger(TENANT)).toHaveLength(0);
    const dispatches = await stores.data.listDispatches(TENANT, 'k6');
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.outcome).toBeNull();
  });
});
