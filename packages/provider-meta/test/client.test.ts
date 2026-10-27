/**
 * Meta provider client: strict validation, bounded retries, breaker and
 * concurrency behavior — all against a stubbed fetch, no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { RiskSignalKind } from '@permitzero/domain/reason-codes';
import { MetaProviderClient, MetaProviderError } from '../src/client.js';
import type { MetaProviderConfig } from '../src/config.js';
import type { ScreeningInput } from '../src/prompt.js';

function config(overrides: Partial<MetaProviderConfig> = {}): MetaProviderConfig {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://api.meta.ai/v1',
    modelId: 'test-model',
    timeoutMs: 1000,
    maxAttempts: 3,
    maxConcurrency: 4,
    retryBaseMs: 10,
    retryCapMs: 100,
    promptVersion: 'risk-hints-prompt-v1',
    breakerThreshold: 2,
    breakerCooldownMs: 1000,
    ...overrides,
  };
}

function input(overrides: Partial<ScreeningInput> = {}): ScreeningInput {
  return {
    toolName: 'payment.execute',
    operation: 'execute',
    taskPurpose: 'Pay an invoice',
    argumentsJson: { invoice_id: 'INV-2041' },
    evidenceRefs: ['invoice:INV-2041'],
    untrustedTexts: [{ ref: 'invoice:INV-2041', text: 'Amount $3,000.00.' }],
    ...overrides,
  };
}

function hintsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'risk-hints.v1',
    instruction_injection_indicators: [],
    extracted_facts: {
      invoice_id: 'INV-2041',
      vendor_id: 'VEN-017',
      vendor_name: null,
      claimed_amount_minor: 300000,
      currency: 'USD',
      purchase_order_id: null,
      beneficiary_ref: 'BEN-017-VERIFIED',
      requested_bank_change: false,
    },
    missing_evidence: [],
    summary: 'Clean invoice text, no injection phrasing.',
    ...overrides,
  };
}

function completion(content: string): Record<string, unknown> {
  return { choices: [{ message: { content } }] };
}

function okFetch(content: string, seen?: { url?: string; auth?: string; body?: unknown }): typeof fetch {
  return (async (url: unknown, init: unknown) => {
    if (seen) {
      seen.url = String(url);
      const headers = (init as { headers?: Record<string, string> }).headers;
      seen.auth = headers?.['authorization'];
      seen.body = JSON.parse(String((init as { body?: string }).body));
    }
    return new Response(JSON.stringify(completion(content)), { status: 200 });
  }) as typeof fetch;
}

describe('meta provider client', () => {
  it('posts to chat/completions and maps hints to the domain shape', async () => {
    const seen: { url?: string; auth?: string; body?: unknown } = {};
    const client = new MetaProviderClient(config(), { fetchFn: okFetch(JSON.stringify(hintsBody()), seen) });
    const result = await client.analyze(input());
    expect(seen.url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(seen.auth).toBe('Bearer test-key');
    expect((seen.body as { model: string }).model).toBe('test-model');
    expect(result.modelId).toBe('test-model');
    expect(result.promptVersion).toBe('risk-hints-prompt-v1');
    expect(result.hints.schemaVersion).toBe('risk-hints.v1');
    expect(result.hints.instructionInjectionIndicators).toEqual([]);
    expect(result.hints.extractedFacts).toEqual({
      invoice_id: 'INV-2041',
      vendor_id: 'VEN-017',
      claimed_amount_minor: 300000,
      currency: 'USD',
      beneficiary_ref: 'BEN-017-VERIFIED',
      requested_bank_change: 0,
    });
    expect(result.hints.summary).toContain('Clean invoice');
  });

  it('accepts markdown-fenced JSON', async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(hintsBody())}\n\`\`\``;
    const client = new MetaProviderClient(config(), { fetchFn: okFetch(fenced) });
    const result = await client.analyze(input());
    expect(result.hints.summary).toContain('Clean invoice');
  });

  it('rejects unparseable and schema-invalid output without retrying', async () => {
    const calls = vi.fn(async () => new Response(JSON.stringify(completion('not json {')), { status: 200 }));
    const client = new MetaProviderClient(config(), { fetchFn: calls as unknown as typeof fetch });
    await expect(client.analyze(input())).rejects.toMatchObject({ errorClass: 'SCHEMA_INVALID', retryable: false });
    expect(calls).toHaveBeenCalledTimes(1);

    const wrongVersion = vi.fn(
      async () => new Response(JSON.stringify(completion(JSON.stringify(hintsBody({ schema_version: 'v9' })))), { status: 200 }),
    );
    const versioned = new MetaProviderClient(config(), { fetchFn: wrongVersion as unknown as typeof fetch });
    await expect(versioned.analyze(input())).rejects.toMatchObject({ errorClass: 'SCHEMA_INVALID' });
    expect(wrongVersion).toHaveBeenCalledTimes(1);
  });

  it('rejects indicators that reference unknown evidence', async () => {
    const body = hintsBody({
      instruction_injection_indicators: [
        { kind: RiskSignalKind.INSTRUCTION_INJECTION, evidence_ref: 'invoice:INV-NOPE', confidence: 0.9 },
      ],
    });
    const client = new MetaProviderClient(config(), { fetchFn: okFetch(JSON.stringify(body)) });
    await expect(client.analyze(input())).rejects.toMatchObject({ errorClass: 'SEMANTICS_INVALID' });
  });

  it('retries rate limits and server errors, then succeeds', async () => {
    const calls = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(completion(JSON.stringify(hintsBody()))), { status: 200 }));
    const slept: number[] = [];
    const client = new MetaProviderClient(config(), {
      fetchFn: calls as unknown as typeof fetch,
      sleepMs: async (ms: number) => {
        slept.push(ms);
      },
      random: () => 0,
    });
    const result = await client.analyze(input());
    expect(result.hints.schemaVersion).toBe('risk-hints.v1');
    expect(calls).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([100, 20]);
  });

  it('gives up after max attempts on persistent server errors', async () => {
    const calls = vi.fn(async () => new Response('boom', { status: 500 }));
    const client = new MetaProviderClient(config({ maxAttempts: 2 }), {
      fetchFn: calls as unknown as typeof fetch,
      sleepMs: async () => undefined,
    });
    await expect(client.analyze(input())).rejects.toMatchObject({
      errorClass: 'PROVIDER_ERROR',
      status: 500,
      retryable: true,
    });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('fails fast on auth and request errors', async () => {
    const denied = vi.fn(async () => new Response('nope', { status: 401 }));
    const auth = new MetaProviderClient(config(), { fetchFn: denied as unknown as typeof fetch });
    await expect(auth.analyze(input())).rejects.toMatchObject({ errorClass: 'AUTH_ERROR', retryable: false });
    expect(denied).toHaveBeenCalledTimes(1);

    const bad = vi.fn(async () => new Response('bad', { status: 422 }));
    const req = new MetaProviderClient(config(), { fetchFn: bad as unknown as typeof fetch });
    await expect(req.analyze(input())).rejects.toMatchObject({ errorClass: 'REQUEST_ERROR', retryable: false });
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('maps aborts to timeouts', async () => {
    const hanging = (async (_url: unknown, init: unknown) => {
      const signal = (init as { signal: AbortSignal }).signal;
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      throw new Error('unreachable');
    }) as typeof fetch;
    const client = new MetaProviderClient(config({ timeoutMs: 20, maxAttempts: 1 }), {
      fetchFn: hanging,
      sleepMs: async () => undefined,
    });
    await expect(client.analyze(input())).rejects.toMatchObject({ errorClass: 'TIMEOUT', retryable: true });
  });

  it('opens the breaker after repeated transport failures and recovers', async () => {
    let now = 0;
    const failing = vi.fn(async () => new Response('boom', { status: 500 }));
    const client = new MetaProviderClient(config({ maxAttempts: 1, breakerThreshold: 2, breakerCooldownMs: 1000 }), {
      fetchFn: failing as unknown as typeof fetch,
      sleepMs: async () => undefined,
      nowMs: () => now,
    });
    expect(client.status()).toMatchObject({ status: 'ok', breaker: 'CLOSED' });
    await expect(client.analyze(input())).rejects.toMatchObject({ errorClass: 'PROVIDER_ERROR' });
    expect(client.status().breaker).toBe('CLOSED');
    await expect(client.analyze(input())).rejects.toMatchObject({ errorClass: 'PROVIDER_ERROR' });
    expect(client.status()).toMatchObject({ status: 'down', breaker: 'OPEN' });
    await expect(client.analyze(input())).rejects.toMatchObject({ errorClass: 'BREAKER_OPEN' });
    expect(failing).toHaveBeenCalledTimes(2);

    now += 1000;
    expect(client.status()).toMatchObject({ status: 'degraded', breaker: 'HALF_OPEN' });
    await expect(client.analyze(input())).rejects.toMatchObject({ errorClass: 'PROVIDER_ERROR' });
    expect(client.status()).toMatchObject({ breaker: 'OPEN' });
  });

  it('does not trip the breaker on auth failures', async () => {
    const denied = vi.fn(async () => new Response('nope', { status: 403 }));
    const client = new MetaProviderClient(config({ maxAttempts: 1, breakerThreshold: 1 }), {
      fetchFn: denied as unknown as typeof fetch,
      sleepMs: async () => undefined,
    });
    await expect(client.analyze(input())).rejects.toMatchObject({ errorClass: 'AUTH_ERROR' });
    expect(client.status()).toMatchObject({ status: 'ok', breaker: 'CLOSED' });
  });

  it('caps concurrent provider calls', async () => {
    let live = 0;
    let peak = 0;
    const slow = (async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      live -= 1;
      return new Response(JSON.stringify(completion(JSON.stringify(hintsBody()))), { status: 200 });
    }) as typeof fetch;
    const client = new MetaProviderClient(config({ maxConcurrency: 2 }), { fetchFn: slow });
    await Promise.all([client.analyze(input()), client.analyze(input()), client.analyze(input())]);
    expect(peak).toBe(2);
  });

  it('bounds the provider payload', async () => {
    const seen: { body?: unknown } = {};
    const client = new MetaProviderClient(config(), { fetchFn: okFetch(JSON.stringify(hintsBody()), seen) });
    await client.analyze(
      input({
        untrustedTexts: Array.from({ length: 12 }, (_, i) => ({ ref: `doc:${i}`, text: 'x'.repeat(9000) })),
        argumentsJson: { blob: 'y'.repeat(20000) },
      }),
    );
    const user = (seen.body as { messages: Array<{ role: string; content: string }> }).messages[1]?.content ?? '';
    expect(user).toContain('doc:0');
    expect(user).not.toContain('doc:11');
    expect(user).toContain('[truncated to fit]');
    expect(user.length).toBeLessThan(60000);
  });

  it('never leaks the key through errors', async () => {
    const denied = vi.fn(async () => new Response('nope', { status: 401 }));
    const client = new MetaProviderClient(config({ apiKey: 'super-secret-key' }), {
      fetchFn: denied as unknown as typeof fetch,
    });
    const err = (await client.analyze(input()).catch((e: unknown) => e)) as MetaProviderError;
    expect(JSON.stringify({ message: err.message, class: err.errorClass, status: err.status })).not.toContain(
      'super-secret-key',
    );
  });
});
