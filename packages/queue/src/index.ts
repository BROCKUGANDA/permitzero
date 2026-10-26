/**
 * @permitzero/queue — outbox dispatcher, worker wrappers and queue names.
 * Depends on narrow ports, never on concrete drivers, so the API can run the
 * dispatcher against PostgreSQL + BullMQ in production and against fakes in
 * tests.
 */
export * from './names.js';
export * from './types.js';
export * from './dispatcher.js';
export * from './workers.js';
export * from './bullmq.js';
export * from './adapters.js';
