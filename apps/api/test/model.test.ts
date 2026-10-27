/**
 * Model adapters: the live Meta adapter maps client results and failures to
 * typed outcomes (never exceptions, never hints on failure), the factory
 * selects by kind, and config honors the deterministic kill-switch.
 */
import { describe, expect, it } from 'vitest';
import { MetaProviderError } from '@permitzero/provider-meta';
import type { MetaProviderClient } from '@permitzero/provider-meta';
import { loadConfig } from '../src/config.js';
import { createModelAdapter, MetaModelAdapter } from '../src/model.js';
import type { ModelAnalysisInput } from '../src/model.js';

function analyzeInput(): ModelAnalysisInput {
  return {
    tenantId: 'ten_test',
    actionId: null,
    toolName: 'payment.execute',
    operation: 'execute',
    taskPurpose: 'Pay up',
    argumentsRedacted: { invoice_id: 'INV-1' },
    evidenceRefs: [],
    untrustedTexts: [],
  };
}

function stubClient(overrides: Partial<MetaProviderClient> = {}): MetaProviderClient {
  return {
    analyze: async () => ({
      hints: {
        schemaVersion: 'risk-hints.v1',
        instructionInjectionIndicators: [],
        extractedFacts: {},
        missingEvidence: [],
        summary: 'clean',
      },
      modelId: 'test-model',
      promptVersion: 'risk-hints-prompt-v1',
      latencyMs: 7,
    }),
    status: () => ({ enabled: true, status: 'ok', breaker: 'CLOSED', modelId: 'test-model' }),
    ...overrides,
  } as MetaProviderClient;
}

describe('meta model adapter', () => {
  it('maps a successful screening to an OK outcome', async () => {
    const adapter = new MetaModelAdapter(stubClient());
    const outcome = await adapter.analyze(analyzeInput());
    expect(outcome).toMatchObject({
      status: 'OK',
      modelId: 'test-model',
      promptVersion: 'risk-hints-prompt-v1',
      errorClass: null,
    });
    expect(outcome.hints?.schemaVersion).toBe('risk-hints.v1');
    expect(adapter.status()).toMatchObject({ enabled: true, modelId: 'test-model' });
  });

  it('maps provider failures to ERROR outcomes without hints', async () => {
    const failing = stubClient({
      analyze: async () => {
        throw new MetaProviderError('SCHEMA_INVALID', 'bad output');
      },
    });
    const outcome = await new MetaModelAdapter(failing).analyze(analyzeInput());
    expect(outcome).toMatchObject({ status: 'ERROR', hints: null, errorClass: 'SCHEMA_INVALID' });
    expect(outcome.modelId).toBe('test-model');
  });

  it('maps timeouts to TIMEOUT outcomes', async () => {
    const timing = stubClient({
      analyze: async () => {
        throw new MetaProviderError('TIMEOUT', 'slow', { retryable: true });
      },
    });
    const outcome = await new MetaModelAdapter(timing).analyze(analyzeInput());
    expect(outcome).toMatchObject({ status: 'TIMEOUT', hints: null, errorClass: 'TIMEOUT' });
  });

  it('selects adapters by kind and requires a client for meta', () => {
    expect(createModelAdapter('disabled').providerName).toBe('disabled');
    expect(createModelAdapter('static').providerName).toBe('static');
    expect(createModelAdapter('meta', { meta: stubClient() }).providerName).toBe('meta');
    expect(() => createModelAdapter('meta')).toThrow('requires a MetaProviderClient');
  });
});

describe('model provider config', () => {
  const base = {
    PERMIT_SIGNING_KEY: 'test-signing-key-0123456789abcdef',
    DATABASE_URL: 'postgres://localhost:5432/x',
  };

  it('defaults to disabled', () => {
    expect(loadConfig({ ...base }).modelProvider).toBe('disabled');
  });

  it('accepts static and meta', () => {
    expect(loadConfig({ ...base, MODEL_PROVIDER: 'static' }).modelProvider).toBe('static');
    expect(loadConfig({ ...base, MODEL_PROVIDER: 'meta' }).modelProvider).toBe('meta');
  });

  it('rejects unknown providers', () => {
    expect(() => loadConfig({ ...base, MODEL_PROVIDER: 'smoke-signals' })).toThrow('MODEL_PROVIDER');
  });

  it('lets MODEL_ENABLED=false force deterministic mode', () => {
    expect(loadConfig({ ...base, MODEL_PROVIDER: 'meta', MODEL_ENABLED: 'false' }).modelProvider).toBe('disabled');
    expect(loadConfig({ ...base, MODEL_PROVIDER: 'meta', MODEL_ENABLED: 'FALSE' }).modelProvider).toBe('disabled');
    expect(loadConfig({ ...base, MODEL_PROVIDER: 'meta', MODEL_ENABLED: 'true' }).modelProvider).toBe('meta');
  });
});
