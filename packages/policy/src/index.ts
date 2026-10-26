/**
 * @permitzero/policy — pure deterministic policy evaluation.
 *
 * No I/O, no database, no clock reads except from the evaluation input. The
 * caller supplies authoritative records; this package turns them into a
 * decision. "Policy store unavailable" is therefore a caller-side fail-closed
 * path, not a swallowed exception.
 */
export * from './revision.js';
export * from './fields.js';
export * from './match.js';
export * from './evaluate.js';
export * from './lint.js';
export * from './simulate.js';
