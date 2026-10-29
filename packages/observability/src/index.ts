/**
 * @permitzero/observability — metrics, trace correlation and SLO arithmetic.
 *
 * Framework-free on purpose: the Fastify hooks that feed these live in
 * `apps/api`, so the worker can emit the same series without importing a web
 * framework, and the SLO math stays testable as pure functions.
 */
export * from './exposition.js';
export * from './metrics.js';
export * from './shared-rate-limit.js';
export * from './slos.js';
export * from './tracing.js';
