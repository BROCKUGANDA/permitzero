/**
 * The worker shares the API's simulation-only boundary: it must never boot a
 * live provider reconciler, even when an operator leaves the old switch set.
 */
import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';

const BASE = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/permitzero_test',
  PERMIT_SIGNING_KEY: 'test-signing-key-0123456789abcdef',
};

describe('simulation-only worker configuration', () => {
  it('refuses to boot with live finance enabled', () => {
    expect(() => loadWorkerConfig({ ...BASE, LIVE_FINANCE_ENABLED: 'true' })).toThrow(/simulation-only/);
  });

  it('allows an explicit off value', () => {
    expect(loadWorkerConfig({ ...BASE, LIVE_FINANCE_ENABLED: 'false' }).appEnv).toBe('test');
  });
});
