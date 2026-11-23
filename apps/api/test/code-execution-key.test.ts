/**
 * The idempotency boundary of arbitrary code execution. A retry must not
 * become a second execution, and a key from one tenant must not be able to
 * collide with another tenant's.
 */
import { describe, expect, it } from 'vitest';
import { deriveCodeExecutionKey, suppliedIdempotencyKey } from '../src/code-execution-key.js';

const BASE = {
  tenantId: 'ten_alpha',
  actorId: 'usr_alpha',
  code: "console.log('hello')",
  language: 'node',
  args: ['one', 'two'],
};

describe('supplied Idempotency-Key', () => {
  it('accepts a bounded, printable key', () => {
    expect(suppliedIdempotencyKey('run-2026_01.02:abc')).toBe('run-2026_01.02:abc');
  });

  it('trims surrounding whitespace', () => {
    expect(suppliedIdempotencyKey('  run-1  ')).toBe('run-1');
  });

  it('refuses anything that cannot be a single unambiguous key', () => {
    expect(suppliedIdempotencyKey(undefined)).toBeNull();
    expect(suppliedIdempotencyKey(['a', 'b'])).toBeNull();
    expect(suppliedIdempotencyKey('')).toBeNull();
    expect(suppliedIdempotencyKey('   ')).toBeNull();
    expect(suppliedIdempotencyKey('a'.repeat(129))).toBeNull();
    expect(suppliedIdempotencyKey('bad key')).toBeNull();
    expect(suppliedIdempotencyKey('bad\nsequence')).toBeNull();
  });
});

describe('derived idempotency key', () => {
  it('is stable for the same request', () => {
    expect(deriveCodeExecutionKey(BASE)).toBe(deriveCodeExecutionKey({ ...BASE }));
  });

  it('changes when any part of the request changes', () => {
    const original = deriveCodeExecutionKey(BASE);
    expect(deriveCodeExecutionKey({ ...BASE, code: 'different' })).not.toBe(original);
    expect(deriveCodeExecutionKey({ ...BASE, language: 'python' })).not.toBe(original);
    expect(deriveCodeExecutionKey({ ...BASE, args: ['one'] })).not.toBe(original);
    expect(deriveCodeExecutionKey({ ...BASE, actorId: 'usr_other' })).not.toBe(original);
    expect(deriveCodeExecutionKey({ ...BASE, tenantId: 'ten_other' })).not.toBe(original);
  });

  it('keeps the tenant in the clear so keys cannot collide across tenants', () => {
    expect(deriveCodeExecutionKey(BASE).startsWith('code:ten_alpha:')).toBe(true);
    expect(deriveCodeExecutionKey({ ...BASE, tenantId: 'ten_other' }).startsWith('code:ten_other:')).toBe(true);
  });
});
