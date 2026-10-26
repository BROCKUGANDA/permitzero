/**
 * @permitzero/domain — entities, enums, state machine, canonicalization, money,
 * redaction and error taxonomy. No I/O, no framework, no database: this package
 * is pure so that every invariant in Master Prompt §5 can be unit-tested without
 * a running service.
 */
export * from './ids.js';
export * from './enums.js';
export * from './canonical.js';
export * from './money.js';
export * from './reason-codes.js';
export * from './errors.js';
export * from './redaction.js';
export * from './types.js';
