# Live Finance Execution — the simulated/live seam

**Status:** implemented, sandbox-ready; live dispatch is OFF unless the deployment explicitly enables it.

## What changed

PermitZero's financial execution is no longer simulated-only. The broker's
connector seam (`packages/broker/src/ports.ts` → `FinanceConnector`) is now
polymorphic: a connector row may dispatch through

- the **simulated** ledger (`SimulatedFinanceConnector`, unchanged), or
- a **live** provider adapter (`packages/connectors` — the Wise connector).

Everything upstream of the seam is unchanged and applies to real money exactly
as it applies to simulated money: deterministic policy, default deny,
two-person approvals, single-use permits bound to the canonical action hash,
dispatch markers, ledger idempotency, honest unknown-outcome reconciliation,
and the append-only audit chain.

## The internal/external boundary

```
INTERNAL (trusted, deterministic)          EXTERNAL (provider-owned)
─────────────────────────────────          ─────────────────────────────
apps/api · apps/worker                     Wise Platform API
packages/domain · schemas · policy
packages/db (RLS, crypto, stores)
packages/broker  ── depends only on ──►    FinanceConnector port
  ├ SimulatedFinanceConnector  (no external calls)
  └ (db wiring) WiseFinanceConnector ──►   packages/connectors (the ONLY
                                            module that talks to a provider)
```

`packages/broker` never imports `packages/connectors`; `packages/db` wires
adapters into the broker at boot. No other module may reach a provider.

## Who connects accounts (OAuth, never API keys)

PermitZero does not hold anyone's provider API keys. Each tenant connects its
OWN Wise account through an OAuth redirect flow:

- `GET /v1/connect/wise/start` — authenticated; hands the browser to Wise.
- `GET /v1/connect/wise/callback` — unauthenticated; trust rides on a
  short-lived, HMAC-signed, provider-bound state value.
- `GET /v1/connected-accounts`, `DELETE /v1/connected-accounts/:id` —
  redacted list and local revoke (tokens destroyed, connectors detached).

The token pair is encrypted at rest under the `secret-material` key and is
decrypted only inside the connector's token manager. It is never logged,
never returned by any API, and never stored in plaintext.

## The guards (all fail closed BEFORE a permit is burned)

1. `LIVE_FINANCE_ENABLED` must be set with the platform OAuth client, or every
   live connector is rejected (`LIVE_FINANCE_DISABLED`).
2. The connector row's `type` must match the wired provider
   (`LIVE_CONNECTOR_NOT_CONFIGURED`).
3. The row must reference an ACTIVE connected account
   (`CONNECTED_ACCOUNT_MISSING`).
4. Every live transfer is capped by `LIVE_MAX_AMOUNT_MINOR` regardless of
   policy (`LIVE_LIMIT_EXCEEDED`) — a policy error cannot widen the ceiling.
5. Payments are only dispatched to beneficiaries registered at the provider
   (`wise:recipient:<id>`); raw bank details never travel through PermitZero,
   and the vendor verification + cooling-period policy still governs every
   beneficiary change.

A rejected live dispatch spends no permit — the same permit executes after the
operator fixes the wiring.

## Honest outcomes with real money

- Ledger first: a repeated idempotency key returns the ORIGINAL receipt and
  never creates a second transfer. Wise's `customerTransactionId` (derived
  deterministically from the same key) is the provider half of the defense.
- The provider's own id is persisted on the dispatch marker the moment it
  exists, so a process dying mid-flight still leaves reconciliation a handle.
- A funded transfer that has not provably arrived is `UNKNOWN_OUTCOME`,
  resolved later against provider truth by the reconciliation sweep — never an
  assumed failure, never a blind retry.

## Receipt semantics

Every receipt carries `simulated: true|false`. Live receipts say
`simulated: false` and are labelled in the UI ("Executed live — real funds").
Exports, evidence records and API responses branch on this field; it may never
be omitted.

## Operational notes

- Sandbox first: point `WISE_API_BASE_URL` at `https://api.sandbox.transferwise.tech`
  until the platform's live onboarding is complete. The code path is identical.
- Compliance obligations attached to real transfers (KYC on beneficiaries,
  sanctions screening, money-transmission rules) sit OUTSIDE PermitZero and
  remain the account owner's responsibility. PermitZero enforces authority,
  limits and evidence; it is not a money transmitter.
- Live connector rows serve `payment.execute` and `vendor.update_bank_details`
  only; `vendor.export` stays simulated-only.

## Environment variables

See `.env.example` (`LIVE_FINANCE_*`, `WISE_*`, `CONNECT_REDIRECT_URI`,
`LIVE_MAX_AMOUNT_MINOR`).

## Provider webhooks (transfers#state-change)

`POST /v1/webhooks/wise` receives Wise's `transfers#state-change` webhooks.

- Registered only when `WISE_WEBHOOK_PUBLIC_KEY` (PEM; base64-wrapped PEMs
  accepted) is set. Otherwise there is no route to probe.
- `X-Signature-SHA256` is verified over the RAW body with RSA-SHA256; a bad
  signature gets 403 and nothing else happens.
- Every delivery is recorded in `webhook_deliveries` keyed by
  `(provider, delivery_id)` BEFORE any work; redeliveries are acknowledged
  without re-processing (a previous attempt that died mid-way is
  re-processed).
- The tenant is resolved by the provider's own transfer id against
  `connector_dispatches.provider_ref` (iterating active tenants, RLS-scoped
  reads — never guessed), then the existing `execution.unknown_outcome` event
  is enqueued on `pz.reconciliation`. The existing reconciliation consumer
  settles the action against provider truth.
- The webhook itself never flips money state.
- Unresolvable references are acked 200 and recorded as `ignored_unknown_ref`
  (Wise would retry forever otherwise); they appear in audit events
  (`provider.webhook_received`).

## Market reference data (Yahoo Finance)

`GET /v1/market-data/quote?symbol=` and `GET /v1/market-data/fx?from=&to=`
serve Yahoo Finance quotes/FX rates. Read-only, authenticated, not
tenant-scoped. Honesty rules: every value carries `source: 'yahoo_finance'`,
`fetched_at`, `market_time` when available, and a `stale` flag when the live
fetch failed and a persisted snapshot older than `MARKET_SNAPSHOT_MAX_AGE_MS`
(default 300_000) was served instead. The worker's sweep pass auto-refreshes
the symbols in `MARKET_FX_PAIRS` (e.g. `USDILS=X,EURILS=X`) on every sweep
interval; an empty list disables the refresh and it reports disabled.
Reference data only — it authorizes nothing.
