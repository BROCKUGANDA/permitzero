/**
 * @permitzero/policy — pure deterministic policy evaluation.
 *
 * No I/O, no database, no clock reads except from the evaluation input. The
 * caller supplies authoritative records; this package turns them into a
 * decision. "Policy store unavailable" is therefore a caller-side fail-closed
 * path, not a swallowed exception.
 *
 * Two modules sit slightly outside that description and say so themselves:
 * `mfa.ts` signs and verifies server-issued step-up assertions (a computation
 * over a server secret, not I/O), and `environment.ts` derives the environment
 * a policy is scoped to rather than accepting it.
 */
export * from './revision.js';
export * from './environment.js';
export * from './mfa.js';
export * from './fields.js';
export * from './match.js';
export * from './evaluate.js';
export * from './lint.js';
export * from './simulate.js';
