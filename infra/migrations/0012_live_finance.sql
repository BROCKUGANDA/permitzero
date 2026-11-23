-- =============================================================================
-- PermitZero — 0012_live_finance.sql
--
-- The simulated/live finance seam, storage half:
--   1. `connected_accounts` — provider accounts tenants connected through
--      OAuth (the USER's account; PermitZero stores references and an
--      encrypted-at-rest token envelope, never provider API keys).
--   2. `connectors.connected_account_id` — the live connector's dispatch
--      identity; SET NULL on account deletion so later dispatches fail closed.
--   3. `connector_dispatches.provider_ref` — the external system's own id for
--      an in-flight effect, persisted the moment the provider returns it, so a
--      process dying mid-flight still leaves reconciliation a handle.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.connected_accounts (
  connected_account_id text        NOT NULL,
  tenant_id            text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Connector namespace (e.g. 'wise'). One ACTIVE account per tenant+provider,
  -- enforced by the partial unique index below.
  provider             text        NOT NULL,
  display_name         text        NOT NULL,
  -- Provider-side profile the token acts on (e.g. the Wise profile id).
  external_profile_id  text        NOT NULL,
  status               text        NOT NULL DEFAULT 'ACTIVE',
  scopes_json          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- SECURITY: the OAuth token pair, encrypted at rest under the
  -- `secret-material` key (packages/db/src/crypto.ts). Decrypted only inside
  -- the connector's token manager; never selected into an API response.
  token_envelope       jsonb,
  token_expires_at     timestamptz,
  connected_by         text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connected_account_id, tenant_id),
  CONSTRAINT chk_connected_accounts_status CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT chk_connected_accounts_provider_nonempty CHECK (length(btrim(provider)) > 0)
);

-- Exactly one ACTIVE account per tenant and provider: reconnecting rotates the
-- row, history stays as REVOKED.
CREATE UNIQUE INDEX IF NOT EXISTS uq_connected_accounts_active_provider
  ON connected_accounts (tenant_id, provider)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_connected_accounts_tenant
  ON connected_accounts (tenant_id, provider);

COMMENT ON COLUMN connected_accounts.token_envelope IS
  'OAuth token pair encrypted under the secret-material key. Plaintext tokens are never stored; the envelope is opened only inside the connector token manager.';

ALTER TABLE connectors ADD COLUMN IF NOT EXISTS connected_account_id text;

ALTER TABLE connectors DROP CONSTRAINT IF EXISTS fk_connectors_connected_account;
ALTER TABLE connectors ADD CONSTRAINT fk_connectors_connected_account
  FOREIGN KEY (connected_account_id, tenant_id)
  REFERENCES connected_accounts (connected_account_id, tenant_id)
  ON DELETE SET NULL;

ALTER TABLE connector_dispatches ADD COLUMN IF NOT EXISTS provider_ref text;

COMMENT ON COLUMN connector_dispatches.provider_ref IS
  'The external system''s own reference for an in-flight effect (e.g. a Wise transfer id). Persisted the moment the provider returns it so a crash between dispatch and receipt still leaves reconciliation a handle on the truth.';

-- Tenant isolation for the new table, same as every tenant-owned table.
SELECT public.pz_enforce_tenant_rls('connected_accounts');
