/**
 * Assert a rejection by its SQLSTATE.
 *
 * Written as a helper rather than `rejects.toMatchObject({ code })` because
 * drizzle 0.45 wraps query failures in `DrizzleQueryError` and moves the driver
 * error to `.cause`. Asserting the literal property would mean pinning the test
 * to one library's error shape, while the production code — `isDbError()` and
 * `pgCode()` — walks the chain. Asserting through the same unwalker is the
 * version-agnostic form of the same check, and it is the check that actually
 * matters: it is what decides whether an idempotency race replays or 500s.
 */
import { expect } from 'vitest';
import { dbErrorCode } from '../src/index.js';

export function isSqlstate(code: string): (err: unknown) => boolean {
  return (err: unknown) => dbErrorCode(err) === code;
}

/** Await a rejection and assert its SQLSTATE, failing with a readable message. */
export async function expectSqlstate(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected a rejection with SQLSTATE ${code}, but the call succeeded`).not.toBeNull();
  expect(dbErrorCode(err), `wrong SQLSTATE; message was ${String((err as Error)?.message ?? err).slice(0, 160)}`).toBe(
    code,
  );
}
