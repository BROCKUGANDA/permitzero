/**
 * The PRD's non-negotiable product boundary: this release is simulation-only.
 * A deployment cannot turn live finance on through API configuration.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/permitzero_test',
  PERMIT_SIGNING_KEY: 'test-signing-key-0123456789abcdef',
};

describe('simulation-only API configuration', () => {
  it('refuses to boot with live finance enabled', () => {
    expect(() => loadConfig({ ...BASE, LIVE_FINANCE_ENABLED: '1' })).toThrow(/simulation-only/);
  });

  it('allows an explicit off value', () => {
    expect(loadConfig({ ...BASE, LIVE_FINANCE_ENABLED: '0' }).appEnv).toBe('test');
  });
});
