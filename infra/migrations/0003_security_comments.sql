-- =============================================================================
-- PermitZero — 0003_security_comments.sql
--
-- Machine-readable documentation of the trust boundaries. `psql \d+` and any
-- schema-introspection tool surfaces these, so the next engineer who touches the
-- column sees the constraint before writing to it.
-- =============================================================================

COMMENT ON COLUMN service_credentials.credential_ref IS
  'Reference into the secret manager. SECURITY: the plaintext secret is never stored in this database.';
COMMENT ON COLUMN service_credentials.secret_hash IS
  'One-way SHA-256 of the credential, used only to match an inbound token. Not reversible; not the secret.';
COMMENT ON COLUMN service_credentials.secret_prefix IS
  'At most 12 characters of the credential, for operator identification only. Never enough to authenticate.';

COMMENT ON COLUMN connectors.credential_ref IS
  'Secret-manager reference resolved by the broker alone (Master Prompt 5.5). SECURITY: no plaintext secret, token or API key is stored in this table.';
COMMENT ON COLUMN connectors.credential_hash IS
  'One-way hash for verification only. Never the secret.';
COMMENT ON COLUMN connectors.credential_prefix IS
  'Short non-reversible label so an operator can distinguish two credentials.';

COMMENT ON COLUMN permits.nonce_hash IS
  'Hash of the single-use nonce. The opaque permit token itself is never persisted in raw form.';
COMMENT ON COLUMN permits.token_hash IS
  'HMAC of the permit token for lookup. The bearer token never appears in this table, in logs, or in the browser bundle.';

COMMENT ON COLUMN invoices.document_text IS
  'UNTRUSTED external content (PRD FR-014 / 6.2). Evidence, never an instruction: it must not modify system prompts, connector scopes or active policies, and no authorization field may be derived from it. The prompt-injection demo payload lives here.';
COMMENT ON COLUMN invoices.document_untrusted IS
  'Always true when document_text is present; enforced by chk_invoices_document_untrusted.';

COMMENT ON COLUMN actions.arguments_json_redacted IS
  'Redacted before persistence (packages/domain redaction.ts). The unredacted arguments are never stored; only arguments_hash commits to their bytes.';
COMMENT ON COLUMN actions.arguments_hash IS
  'Canonical hash of the authoritative arguments. Approvals and permits bind to exactly this value.';
COMMENT ON COLUMN actions.idempotency_key IS
  'Client idempotency key, distinct from action_id and from connector_idempotency_key (PRD 12.5).';

COMMENT ON COLUMN audit_events.payload_redacted_json IS
  'Redacted payload. No secrets, full bank details or raw model prompts (PRD FR-074).';
COMMENT ON COLUMN audit_events.sequence IS
  'Gapless per tenant, assigned under a transaction-scoped advisory lock by trg_audit_events_chain.';
COMMENT ON COLUMN audit_events.previous_hash IS
  'event_hash of sequence-1 for the same tenant; NULL only for the genesis event.';
COMMENT ON TABLE audit_events IS
  'Append-only. UPDATE and DELETE raise via trg_audit_events_no_update / trg_audit_events_no_delete. Corrections are compensating events (PRD FR-052).';

COMMENT ON COLUMN model_evaluations.output_json_validated IS
  'Schema-validated and redacted model output only. Raw prompts and raw completions are not stored by default (PRD FR-074).';
COMMENT ON TABLE model_evaluations IS
  'Advisory model telemetry. Nothing in this table may authorize, approve, sign a permit or modify policy (PRD FR-071).';

COMMENT ON COLUMN outbox_events.payload_json IS
  'IDs and minimal metadata only — never secrets or large evidence bodies (PRD 12.4). Written in the same transaction as the state change it announces.';

COMMENT ON COLUMN idempotency_records.request_hash IS
  'Canonical request hash. Same key + same hash returns the stored result; same key + different hash is 409 IDEMPOTENCY_KEY_REUSE.';

COMMENT ON COLUMN connector_ledger.connector_idempotency_key IS
  'The simulated connector ledger is keyed by this value: a repeated key returns the ORIGINAL receipt instead of creating a second side effect.';

COMMENT ON COLUMN enforcement_modes.protected_writes_allowed IS
  'A service may be alive but not ready for protected writes (PRD 10.8). True only in ENFORCED mode.';

COMMENT ON TABLE tenants IS
  'Root of tenant scoping. Every tenant-owned table carries tenant_id NOT NULL REFERENCES tenants(id), and child foreign keys are composite so a row cannot reference a parent in another tenant (Master Prompt 5.15).';

COMMENT ON COLUMN invoices.amount_minor IS
  'Integer minor units in bigint. Never a float (PRD 9). Values above 2^53 are exact in the database; the TypeScript boundary converts and refuses unsafe magnitudes.';
COMMENT ON COLUMN purchase_orders.amount_minor IS
  'Integer minor units in bigint. Never a float (PRD 9).';
COMMENT ON COLUMN executions.amount_minor IS
  'Integer minor units in bigint, copied from the authorized action for reconciliation.';
COMMENT ON COLUMN connector_ledger.amount_minor IS
  'Integer minor units in bigint, as recorded on the connector receipt.';
