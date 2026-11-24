# Simulation-only boundary

## Scope

This release executes financial operations only against PermitZero's isolated simulated ledger. It has no live banking, payment initiation, custody, private-key management, settlement, or payment-rail connectivity. This is a product boundary, not a deployment default.

## Enforced controls

- `LIVE_FINANCE_ENABLED=true` fails API and worker startup with a `simulation-only` error. There is no supported runtime switch for live finance.
- The Wise OAuth start/callback routes and the inbound Wise webhook route are not registered. A configured provider credential or webhook key does not create a route.
- The shared broker factory refuses any live-finance wiring object before it can construct a Wise or Stripe adapter.
- Non-simulated connector rows fail closed through `UnwiredLiveConnector`; they cannot dispatch.
- The console's former connected-accounts screen is now a simulation-only information page and does not offer a live Connect action.
- Simulated receipts, ledger entries, UI states, and exports remain explicitly labelled as simulated.

## Tests

- `apps/api/test/simulation-boundary.test.ts` proves API and worker configuration reject live-finance enablement.
- `apps/api/test/connect-state.test.ts` proves the OAuth route is absent even when provider environment values exist.
- `apps/api/test/webhook-dedupe.test.ts` proves the inbound provider webhook route is absent even when a verification key is configured.
- `packages/broker/test/broker.live.test.ts` proves an unwired live connector row is rejected before dispatch and does not burn its permit.

## Historical data

The database may retain `connected_accounts` and `webhook_deliveries` rows from earlier deployments. They are evidence/history only: no runtime route reads them to construct a live provider session, and no outbound provider call can be made from them in this release.

## Future integrations

Any future live financial integration requires a separate product, legal, risk, security, and architecture review, plus a new release boundary and threat model. It must not be added as a dormant flag in this code path.
