/**
 * @permitzero/connectors — LIVE connector adapters.
 *
 * This package is the internal/external seam in physical form: everything in
 * here talks to an EXTERNAL payment provider. `packages/broker` (the execution
 * core) depends only on the `FinanceConnector` port and never imports this
 * package; `packages/db` wires the adapters into the broker at boot. No other
 * module may reach a provider.
 *
 * Credentials rule: PermitZero never holds a provider API key. Users connect
 * their OWN provider accounts through OAuth (see `oauth.ts`); the resulting
 * tokens are stored encrypted at rest by the caller and surfaced to this
 * package only through the `TokenStore` port.
 */
export * from './uuid.js';
export * from './oauth.js';
export * from './token-manager.js';
export * from './wise-client.js';
export * from './wise-connector.js';
export * from './wise-webhook.js';
export * from './yahoo-finance.js';
export * from './http-connector.js';
export * from './notification-sink.js';
export * from './code-execution-connector.js';
export * from './stripe-connector.js';
