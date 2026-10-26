/**
 * @permitzero/worker — outbox dispatching, queue consumers and database
 * sweeps. main.ts owns process wiring; everything else is importable for
 * tests and for the API's honest-disabled modes.
 */
export * from './config.js';
export * from './handlers/outbox-events.js';
export * from './handlers/reconcile.js';
export * from './sweeps.js';
export * from './worker.js';
