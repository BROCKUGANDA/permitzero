-- =============================================================================
-- PermitZero — 0005_credential_names_outbox_freeze.sql
--
-- Two storage-layer invariants the repositories must not be trusted to
-- enforce alone:
--
--   1. `service_credentials` — an ACTIVE credential name is unambiguous
--      within its tenant. Operators revoke and rotate by name; two live
--      rows called 'worker' invite revoking the wrong one. Scoped to
--      ACTIVE rows so a revoked name can be re-issued during rotation.
--   2. `outbox_events` — a PUBLISHED row is delivery history. Flipping it
--      back to FAILED would resurrect an event the dispatcher already
--      handed to the queue and silently publish it twice. Published rows
--      reject every UPDATE; retention deletes stay allowed so history can
--      still be aged out by an explicit purge, never by the dispatcher.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. One live credential per (tenant, name)
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_credentials_active_name
  ON service_credentials (tenant_id, name)
  WHERE status = 'ACTIVE';

-- -----------------------------------------------------------------------------
-- 2. Published outbox rows are frozen
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pz_outbox_events_freeze_published() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION
      'outbox event % was already published and cannot be modified (PermitZero: PUBLISHED is terminal)',
      OLD.outbox_event_id
      USING ERRCODE = 'feature_not_supported';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_outbox_events_freeze_published ON outbox_events;
CREATE TRIGGER trg_outbox_events_freeze_published
  BEFORE UPDATE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION pz_outbox_events_freeze_published();
