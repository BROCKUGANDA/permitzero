-- =============================================================================
-- PermitZero — 0013_market_and_webhooks.sql
--
-- Global (non-tenant) reference tables for two provider-adjacent capabilities:
--
--   1. `market_snapshots` — Yahoo Finance quotes/FX rates fetched by the
--      automatic refresh sweep, so the API can serve fresh-but-offline data
--      with honest staleness labels. Market reference data is not tenant data.
--   2. `webhook_deliveries` — dedupe + routing record for provider webhooks
--      (Wise transfers#state-change). Dedupe is global by design: a delivery id
--      is unique per provider regardless of which tenant it routes to.
--
-- Plus an index for looking a dispatch up by its provider's own reference,
-- which the webhook resolver needs.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.market_snapshots (
  symbol       text        PRIMARY KEY,
  price        text        NOT NULL,
  currency     text,
  source       text        NOT NULL DEFAULT 'yahoo_finance',
  -- When Yahoo says the quote is from (chart meta regularMarketTime).
  market_time  timestamptz,
  fetched_at   timestamptz NOT NULL,
  raw_json     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT chk_market_snapshots_symbol CHECK (symbol ~ '^[A-Za-z0-9.^=_-]{1,32}$'),
  CONSTRAINT chk_market_snapshots_price CHECK (length(btrim(price)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_fetched
  ON market_snapshots (fetched_at);

COMMENT ON TABLE market_snapshots IS
  'Global market reference data from Yahoo Finance. Not tenant-owned; served read-only behind authentication; staleness is derived from fetched_at.';

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  provider           text        NOT NULL,
  delivery_id        text        NOT NULL,
  trace_id           text        NOT NULL,
  -- What the route did with the delivery: received | enqueued | ignored_*.
  outcome            text        NOT NULL DEFAULT 'received',
  -- Set when the delivery could be tied to a tenant (after a provider_ref
  -- lookup). Not a tenant owner: the dedupe key is provider+delivery_id.
  resolved_tenant_id text,
  resolved_action_id text,
  provider_ref       text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, delivery_id),
  CONSTRAINT chk_webhook_deliveries_outcome CHECK (outcome ~ '^[a-z_]{3,64}$')
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_provider_ref
  ON webhook_deliveries (provider, provider_ref);

COMMENT ON TABLE webhook_deliveries IS
  'Provider webhook dedupe + routing evidence. outcome classifies every delivery: enqueued (reconciliation nudged), ignored_* (nothing to reconcile).';

-- Dispatches resolved by the provider's own id (the webhook's lookup key).
CREATE INDEX IF NOT EXISTS idx_dispatches_provider_ref
  ON connector_dispatches (provider_ref);

-- Global reference tables carry no tenant_id, so no RLS applies (same class as
-- `_migrations` and `tenants`); every tenant-bearing table remains enforced.
