-- =============================================================================
-- PermitZero — 0002_triggers.sql
--
-- The invariants that must hold even if every application-layer check is
-- bypassed (Master Prompt §5: "Add invariant tests that explicitly try to
-- violate each one").
--
--   1. `policy_revisions` — a PUBLISHED revision's content is immutable
--      (PRD FR-024). Status transitions remain allowed; `policy_json`,
--      `policy_hash` and `revision_number` do not, and a PUBLISHED row cannot be
--      deleted at all.
--   2. `audit_events` — append-only. UPDATE and DELETE raise unconditionally;
--      corrections are compensating events (PRD FR-052).
--   3. `audit_events` — the per-tenant hash chain is assigned and verified inside
--      the database, under a transaction-scoped advisory lock, so concurrent
--      writers cannot produce duplicate, ambiguous or gapped `sequence` values
--      (PRD §9.1).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. updated_at maintenance
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pz_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants', 'users', 'tenant_memberships', 'agents', 'service_credentials',
    'policies', 'actions', 'approvals', 'permits', 'connectors', 'executions',
    'outbox_events', 'idempotency_records', 'vendors', 'invoices',
    'purchase_orders', 'enforcement_modes', 'replay_sessions'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pz_set_updated_at()',
      t, t
    );
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. Immutable published policy revisions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pz_policy_revision_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'PUBLISHED' THEN
      RAISE EXCEPTION
        'PUBLISHED policy revision % is immutable and cannot be deleted (PermitZero FR-024)',
        OLD.revision_id
        USING ERRCODE = 'feature_not_supported';
    END IF;
    RETURN OLD;
  END IF;

  -- Content is frozen once the revision is published, or in the very statement
  -- that publishes it. Lifecycle columns (status, published_at, change_reason)
  -- stay writable so DRAFT -> READY -> PUBLISHED and PUBLISHED -> ROLLED_BACK
  -- remain possible.
  IF OLD.status = 'PUBLISHED' OR NEW.status = 'PUBLISHED' THEN
    IF NEW.policy_json IS DISTINCT FROM OLD.policy_json THEN
      RAISE EXCEPTION
        'policy_json of PUBLISHED revision % is immutable; create a new revision instead',
        OLD.revision_id
        USING ERRCODE = 'feature_not_supported';
    END IF;
    IF NEW.policy_hash IS DISTINCT FROM OLD.policy_hash THEN
      RAISE EXCEPTION
        'policy_hash of PUBLISHED revision % is immutable; create a new revision instead',
        OLD.revision_id
        USING ERRCODE = 'feature_not_supported';
    END IF;
    IF NEW.revision_number IS DISTINCT FROM OLD.revision_number THEN
      RAISE EXCEPTION
        'revision_number of PUBLISHED revision % is immutable',
        OLD.revision_id
        USING ERRCODE = 'feature_not_supported';
    END IF;
    IF OLD.status = 'PUBLISHED' AND NEW.status NOT IN ('PUBLISHED', 'ROLLED_BACK') THEN
      RAISE EXCEPTION
        'PUBLISHED revision % may only move to ROLLED_BACK, not to %',
        OLD.revision_id, NEW.status
        USING ERRCODE = 'feature_not_supported';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_policy_revisions_immutable ON policy_revisions;
CREATE TRIGGER trg_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON policy_revisions
  FOR EACH ROW EXECUTE FUNCTION pz_policy_revision_immutable();

-- -----------------------------------------------------------------------------
-- 3. Append-only audit trail + per-tenant gapless hash chain
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pz_audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events is append-only: % is not permitted (PermitZero FR-052). Record a compensating event instead.',
    TG_OP
    USING ERRCODE = 'feature_not_supported';
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_audit_events_no_update ON audit_events;
CREATE TRIGGER trg_audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION pz_audit_events_append_only();

DROP TRIGGER IF EXISTS trg_audit_events_no_delete ON audit_events;
CREATE TRIGGER trg_audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION pz_audit_events_append_only();

-- TRUNCATE is intentionally not blocked: `resetDb()` needs it, and TRUNCATE is an
-- administrative operation, not an "ordinary API" rewrite of history.

CREATE OR REPLACE FUNCTION pz_audit_events_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head_sequence bigint;
  head_hash     text;
BEGIN
  -- Serialize every writer for this tenant for the lifetime of the transaction.
  -- Two concurrent inserts cannot both read the same head, so `sequence` stays
  -- unique AND gapless, and `previous_hash` always names the real predecessor.
  PERFORM pg_advisory_xact_lock(hashtextextended('pz_audit_chain:' || NEW.tenant_id, 0));

  SELECT COALESCE(MAX(sequence), 0),
         (array_agg(event_hash ORDER BY sequence DESC))[1]
    INTO head_sequence, head_hash
    FROM audit_events
   WHERE tenant_id = NEW.tenant_id;

  IF NEW.sequence IS NULL THEN
    NEW.sequence := head_sequence + 1;
  ELSIF NEW.sequence <> head_sequence + 1 THEN
    RAISE EXCEPTION
      'audit sequence % is not the next value for tenant % (expected %); concurrent writers must serialize',
      NEW.sequence, NEW.tenant_id, head_sequence + 1
      USING ERRCODE = 'unique_violation';
  END IF;

  IF head_sequence = 0 THEN
    IF NEW.previous_hash IS NOT NULL THEN
      RAISE EXCEPTION
        'genesis audit event for tenant % must have a NULL previous_hash', NEW.tenant_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.previous_hash IS DISTINCT FROM head_hash THEN
    RAISE EXCEPTION
      'audit hash chain broken for tenant % at sequence %: previous_hash does not match the chain head',
      NEW.tenant_id, NEW.sequence
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_audit_events_chain ON audit_events;
CREATE TRIGGER trg_audit_events_chain
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION pz_audit_events_chain();
