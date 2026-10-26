/**
 * @permitzero/schemas — the single source of truth for every shape that crosses
 * a boundary: HTTP requests/responses, the policy document DSL, and the strict
 * Meta Model API structured output. Shared by the API, the worker and the web
 * dashboard so the three cannot drift apart.
 */
export * from './common.js';
export * from './policy.js';
export * from './model.js';
export * from './api.js';
