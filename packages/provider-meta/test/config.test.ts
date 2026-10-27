import { describe, expect, it } from 'vitest';
import { loadMetaConfig } from '../src/config.js';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { MODEL_API_KEY: 'k', MODEL_ID: 'm', ...overrides };
}

describe('meta provider config', () => {
  it('loads defaults', () => {
    expect(loadMetaConfig(env())).toMatchObject({
      apiKey: 'k',
      baseUrl: 'https://api.meta.ai/v1',
      modelId: 'm',
      timeoutMs: 30000,
      maxAttempts: 5,
      maxConcurrency: 4,
      retryBaseMs: 250,
      retryCapMs: 8000,
      promptVersion: 'risk-hints-prompt-v1',
      breakerThreshold: 5,
      breakerCooldownMs: 30000,
    });
  });

  it('names missing secrets without printing values', () => {
    expect(() => loadMetaConfig(env({ MODEL_API_KEY: undefined }))).toThrow('MODEL_API_KEY');
    expect(() => loadMetaConfig(env({ MODEL_ID: undefined }))).toThrow('MODEL_ID');
  });

  it('rejects bad urls, ranges and unknown schema versions', () => {
    expect(() => loadMetaConfig(env({ MODEL_API_BASE_URL: 'not-a-url' }))).toThrow('MODEL_API_BASE_URL');
    expect(() => loadMetaConfig(env({ MODEL_API_BASE_URL: 'ftp://x' }))).toThrow('MODEL_API_BASE_URL');
    expect(() => loadMetaConfig(env({ MODEL_TIMEOUT_MS: 'nope' }))).toThrow('MODEL_TIMEOUT_MS');
    expect(() => loadMetaConfig(env({ MODEL_MAX_ATTEMPTS: '99' }))).toThrow('MODEL_MAX_ATTEMPTS');
    expect(() => loadMetaConfig(env({ MODEL_SCHEMA_VERSION: 'risk-hints.v9' }))).toThrow('MODEL_SCHEMA_VERSION');
  });

  it('trims base url slashes', () => {
    expect(loadMetaConfig(env({ MODEL_API_BASE_URL: 'https://x.test/v1//' })).baseUrl).toBe('https://x.test/v1');
  });
});
