-- =============================================================================
-- PermitZero — 0004_dispatches_outbox_queue.sql
--
-- Follow-up storage the broker ports require:
--   1. `connector_dispatches` — durable dispatch markers so reconciliation can
--      distinguish "definitely did not happen" from "lost mid-flight".
--   2. `outbox_events.queue_name` — the dispatcher routes per row; the queue
--      name is routing data and must live beside the payload.
--   3. `executions` provenance columns (`permit_id`, `permit_nonce_hash`,
--      `actor_id`, `trace_id`) — evidence linking an attempt to its permit.
-- =============================================================================

CREATE TABLE IF NOT EXISTS connector_dispatches (
  dispatch_id               text        NOT NULL,
  tenant_id                 text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_idempotency_key text        NOT NULL,
  operation                 text        NOT NULL,
  started_at                timestamptz NOT NULL,
  completed_at              timestamptz,
  outcome                   text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dispatch_id, tenant_id),
  CONSTRAINT chk_dispatches_completed CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_dispatches_tenant_key
  ON connector_dispatches (tenant_id, connector_idempotency_key);

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS queue_name text NOT NULL DEFAULT 'pz.outbox';
ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS chk_outbox_queue_name;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_queue_name CHECK (
  queue_name IN ('pz.outbox', 'pz.model-analysis', 'pz.reconciliation', 'pz.replay', 'pz.dlq')
);

ALTER TABLE executions ADD COLUMN IF NOT EXISTS permit_id text;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS permit_nonce_hash text;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS actor_id text NOT NULL DEFAULT 'unknown';
ALTER TABLE executions ADD COLUMN IF NOT EXISTS trace_id text NOT NULL DEFAULT 'unknown';
ALTER TABLE executions ALTER COLUMN actor_id DROP DEFAULT;
ALTER TABLE executions ALTER COLUMN trace_id DROP DEFAULT;

-- Operation evidence (invoice/vendor/action linkage) beside the receipt.
ALTER TABLE connector_ledger ADD COLUMN IF NOT EXISTS detail_json_redacted jsonb NOT NULL DEFAULT '{}';
