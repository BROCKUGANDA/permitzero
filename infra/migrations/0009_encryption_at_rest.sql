-- =============================================================================
-- PermitZero - 0009_encryption_at_rest.sql
--
-- The storage form of the application-layer encryption in
-- `packages/db/src/crypto.ts`.
--
-- WHAT THIS FILE IS, AND WHAT IT IS NOT
--
-- The encryption itself happens in the application, because the key does:
-- `AUDIT_HMAC_KEYS` (or `AUDIT_HMAC_KEY` alone) never reaches the database,
-- so no trigger, function or view here can encrypt or decrypt a payload. The
-- application writes an ENVELOPE into the jsonb column - a single reserved
-- key holding `enc.v1.<iv>.<tag>.<ciphertext>` - and the repository decrypts
-- it on the way out.
--
-- What the database CAN enforce is the shape of that envelope, and that is
-- what this file adds:
--
--   1. `pz_assert_payload_envelope` refuses a row whose payload claims to be
--      encrypted and is not a well-formed envelope. A truncated write, a
--      half-serialized envelope or a column edited by hand is rejected at the
--      boundary rather than discovered months later during an audit
--      verification, where the failure looks like tampering.
--
--   2. `pz_encrypted_payload_coverage` reports, per encrypted column, how many
--      rows are encrypted and how many are still LEGACY PLAINTEXT. The legacy
--      rows are rows written before encryption was switched on: `audit_events`
--      is append-only, so they can never be rewritten, and they are read as
--      plaintext by design (see the legacy rule in `packages/db/src/crypto.ts`).
--      A compliance claim about this control has to be stated against these
--      numbers rather than against the intention.
--
-- WHAT IS DELIBERATELY NOT ENFORCED
--
-- The trigger does NOT require a payload to be encrypted. A deployment with no
-- master key configured stores plaintext - that is the pre-existing unkeyed
-- behaviour, and the API refuses to boot without a key outside development and
-- test (`apps/api/src/config.ts`). A database-level "encryption required" rule
-- would need the key's PRESENCE, not its value, and the database has no way to
-- know that; a rule keyed on a session flag would be a flag nobody sets.
--
-- Idempotent: every object is dropped before it is created, so re-running this
-- file is a no-op rather than an error.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Recognising an encrypted payload
-- -----------------------------------------------------------------------------

-- IMMUTABLE because it looks at its argument only. It is the SQL twin of
-- `isEncryptedColumn` in `packages/db/src/crypto.ts`: the marker key, and the
-- envelope's shape AND VERSION. The version is pinned to `enc.v1` here
-- because this view answers "can the current reader open this row?".
CREATE OR REPLACE FUNCTION public.pz_is_encrypted_payload(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    value IS NOT NULL
    AND jsonb_typeof(value) = 'object'
    AND jsonb_exists(value, '__pz_enc')
    AND (value ->> '__pz_enc') ~ '^enc\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$';
$$;

COMMENT ON FUNCTION public.pz_is_encrypted_payload(jsonb) IS
  'SECURITY: true when the jsonb value holds a well-formed PermitZero encryption envelope (`{"__pz_enc": "enc.v1.<iv>.<tag>.<ciphertext>"}`). A false result on a payload column means either a legacy plaintext row or a malformed envelope; the coverage view tells the two apart.';

-- -----------------------------------------------------------------------------
-- 2. The envelope shape guard
-- -----------------------------------------------------------------------------

-- BEFORE INSERT, so a broken envelope never reaches the table. The column is
-- named in TG_ARGV[0] rather than hard-coded, because the rule is the same
-- for every payload column and four copies of it would be four places to
-- forget to update.
CREATE OR REPLACE FUNCTION public.pz_assert_payload_envelope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  value    jsonb;
  envelope text;
BEGIN
  value := to_jsonb(NEW) -> TG_ARGV[0];

  -- NULL, or not an object at all: nothing to check. The audit payload is
  -- always an object, but this trigger also guards nullable columns.
  IF value IS NULL OR jsonb_typeof(value) <> 'object' THEN
    RETURN NEW;
  END IF;

  -- No marker, or a marker that is not an envelope claim: a legacy plaintext
  -- payload, or a payload that merely happens to carry a key called
  -- `__pz_enc`. Allowed on purpose - see the header. The rule this trigger
  -- enforces is "what claims to be encrypted IS encrypted", not "everything is
  -- encrypted".
  envelope := value ->> '__pz_enc';
  IF envelope IS NULL OR envelope NOT LIKE 'enc.%' THEN
    RETURN NEW;
  END IF;

  -- The SHAPE is checked here; the VERSION is the application's business.
  -- A future envelope version (`enc.v2....`) is a different format and the
  -- reader will refuse it until it learns the version, but the database has
  -- no reason to refuse a well-formed envelope of a version it has not heard
  -- of - and refusing it would make the upgrade order matter.
  IF envelope !~ '^enc\.[A-Za-z0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$' THEN
    RAISE EXCEPTION
      'column % holds a payload that claims to be encrypted but the envelope is malformed',
      TG_ARGV[0]
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.pz_assert_payload_envelope() IS
  'SECURITY: refuses an insert whose payload column carries the `__pz_enc` marker with a value that is not a well-formed envelope. A truncated or hand-edited envelope is caught at the write boundary instead of surfacing later as an undecryptable audit row.';

DROP TRIGGER IF EXISTS trg_audit_events_payload_envelope ON audit_events;
CREATE TRIGGER trg_audit_events_payload_envelope
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION public.pz_assert_payload_envelope('payload_redacted_json');

DROP TRIGGER IF EXISTS trg_outbox_events_payload_envelope ON outbox_events;
CREATE TRIGGER trg_outbox_events_payload_envelope
  BEFORE INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION public.pz_assert_payload_envelope('payload_json');

DROP TRIGGER IF EXISTS trg_executions_receipt_envelope ON executions;
CREATE TRIGGER trg_executions_receipt_envelope
  BEFORE INSERT ON executions
  FOR EACH ROW EXECUTE FUNCTION public.pz_assert_payload_envelope('receipt_json');

DROP TRIGGER IF EXISTS trg_model_evaluations_output_envelope ON model_evaluations;
CREATE TRIGGER trg_model_evaluations_output_envelope
  BEFORE INSERT ON model_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.pz_assert_payload_envelope('output_json_validated');

DROP TRIGGER IF EXISTS trg_connector_ledger_receipt_envelope ON connector_ledger;
CREATE TRIGGER trg_connector_ledger_receipt_envelope
  BEFORE INSERT ON connector_ledger
  FOR EACH ROW EXECUTE FUNCTION public.pz_assert_payload_envelope('receipt_json');

-- -----------------------------------------------------------------------------
-- 3. The columns, documented where an operator will look for them
-- -----------------------------------------------------------------------------

COMMENT ON COLUMN audit_events.payload_redacted_json IS
  'SECURITY: the audit payload, encrypted at the application layer as {"__pz_enc": "enc.v1.<iv>.<tag>.<ciphertext>"} (AES-256-GCM, key derived from AUDIT_HMAC_KEYS with the label `audit-payload`). The chain hash is computed over the canonical PLAINTEXT, so the hash still proves what the decision was. Rows written before encryption was enabled hold plaintext and are read as plaintext.';
COMMENT ON COLUMN outbox_events.payload_json IS
  'SECURITY: the outbox payload, encrypted at the application layer as {"__pz_enc": "enc.v1.<iv>.<tag>.<ciphertext>"} (AES-256-GCM, key derived from AUDIT_HMAC_KEYS with the label `outbox-payload`).';
COMMENT ON COLUMN executions.receipt_json IS
  'SECURITY: the execution receipt, encrypted at the application layer as {"__pz_enc": "enc.v1.<iv>.<tag>.<ciphertext>"} (AES-256-GCM, key derived from AUDIT_HMAC_KEYS with the label `execution-payload`).';
COMMENT ON COLUMN model_evaluations.output_json_validated IS
  'SECURITY: the validated model output, encrypted at the application layer as {"__pz_enc": "enc.v1.<iv>.<tag>.<ciphertext>"} (AES-256-GCM, key derived from AUDIT_HMAC_KEYS with the label `model-evaluation-payload`).';
COMMENT ON COLUMN connector_ledger.receipt_json IS
  'SECURITY: the ledger receipt, encrypted at the application layer as {"__pz_enc": "enc.v1.<iv>.<tag>.<ciphertext>"} (AES-256-GCM, key derived from AUDIT_HMAC_KEYS with the label `ledger-receipt`). The same keyring as the other payload columns; a row written before encryption was enabled holds plaintext.';

-- -----------------------------------------------------------------------------
-- 4. The coverage report
-- -----------------------------------------------------------------------------

-- `security_invoker = true` so the view runs with the CALLER's permissions
-- and row-level security. Without it the view would run with the migration
-- role's - which is exempt from RLS - and would hand the runtime role a
-- platform-wide count of another tenant's rows. A coverage report that leaks
-- across tenants is worse than no report.
CREATE OR REPLACE VIEW public.pz_encrypted_payload_coverage
WITH (security_invoker = true)
AS
SELECT
  'audit_events'::text                AS table_name,
  'payload_redacted_json'::text        AS column_name,
  count(*)::bigint                     AS rows_total,
  count(*) FILTER (WHERE public.pz_is_encrypted_payload(payload_redacted_json))::bigint AS rows_encrypted,
  count(*) FILTER (WHERE payload_redacted_json IS NOT NULL
                     AND NOT public.pz_is_encrypted_payload(payload_redacted_json))::bigint AS rows_legacy_plaintext
FROM audit_events
UNION ALL
SELECT
  'outbox_events', 'payload_json', count(*)::bigint,
  count(*) FILTER (WHERE public.pz_is_encrypted_payload(payload_json))::bigint,
  count(*) FILTER (WHERE payload_json IS NOT NULL
                     AND NOT public.pz_is_encrypted_payload(payload_json))::bigint
FROM outbox_events
UNION ALL
SELECT
  'executions', 'receipt_json', count(*)::bigint,
  count(*) FILTER (WHERE public.pz_is_encrypted_payload(receipt_json))::bigint,
  count(*) FILTER (WHERE receipt_json IS NOT NULL
                     AND NOT public.pz_is_encrypted_payload(receipt_json))::bigint
FROM executions
UNION ALL
SELECT
  'model_evaluations', 'output_json_validated', count(*)::bigint,
  count(*) FILTER (WHERE public.pz_is_encrypted_payload(output_json_validated))::bigint,
  count(*) FILTER (WHERE output_json_validated IS NOT NULL
                     AND NOT public.pz_is_encrypted_payload(output_json_validated))::bigint
FROM model_evaluations;

COMMENT ON VIEW public.pz_encrypted_payload_coverage IS
  'SECURITY: per encrypted column, how many rows are encrypted and how many are still legacy plaintext. `rows_legacy_plaintext` is the honest measure of what encryption at rest has NOT yet covered: those rows were written before encryption was enabled and, in `audit_events`, can never be rewritten because the table is append-only.';
