/**
 * @permitzero/provider-meta — Meta Model API client for advisory screening.
 * Structured hints in, validated `RiskHints` out; anything else is a typed
 * failure the caller treats as "signal unavailable", never as approval.
 */
export * from './config.js';
export * from './prompt.js';
export * from './client.js';
