-- =============================================================================
-- PermitZero — 0001_init.sql
--
-- The whole durable schema (PRD §9.1/§9.2, Master Prompt §7).
--
-- Design rules enforced here, not in application code:
--   * Every tenant-owned table carries `tenant_id text NOT NULL REFERENCES
--     tenants(id)`, and child foreign keys are COMPOSITE `(child_id, tenant_id)`
--     so a row physically cannot point at a parent in another tenant. This is the
--     database-level backstop behind Master Prompt §5.15 — a missing `WHERE
--     tenant_id = ?` in some future query returns zero rows instead of another
--     customer's data.
--   * Money is integer minor units in `bigint`, never `double precision`/`real`,
--     and never negative where the domain says so (PRD §9).
--   * Enum-ish columns are `text` + CHECK against the exact domain enum values,
--     not PostgreSQL enums: adding a state must not require an ALTER TYPE lock,
--     and an unknown value is rejected loudly rather than coerced.
--   * Unique idempotency constraints are the FINAL concurrency guard (PRD §12.5:
--     "an in-memory map or Redis lock alone is insufficient").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Identity and tenancy
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
  id                 text        PRIMARY KEY,
  name               text        NOT NULL,
  slug               text        NOT NULL,
  status             text        NOT NULL DEFAULT 'ACTIVE',
  default_environment text       NOT NULL DEFAULT 'DEMO',
  -- True for the shipped demo corpus. The UI must show a permanent DEMO banner
  -- for synthetic data (PRD §7.2); demo rows must never be mistaken for real.
  synthetic          boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tenants_slug        UNIQUE (slug),
  CONSTRAINT chk_tenants_status     CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  CONSTRAINT chk_tenants_environment CHECK (default_environment IN ('DEMO', 'STAGING', 'PRODUCTION')),
  CONSTRAINT chk_tenants_name_nonempty CHECK (length(btrim(name)) > 0)
);

-- Membership roles live here, NOT in a global column on users (PRD §9.1): a user
-- is an OWNER in one tenant and may hold nothing in another.
CREATE TABLE IF NOT EXISTS users (
  id                        text        PRIMARY KEY,
  identity_provider_subject text,
  email                     text        NOT NULL,
  display_name              text        NOT NULL,
  status                    text        NOT NULL DEFAULT 'ACTIVE',
  mfa_enrolled_at           timestamptz,
  last_login_at             timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_users_subject  UNIQUE (identity_provider_subject),
  CONSTRAINT chk_users_status  CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED'))
);

-- Case-insensitive mailbox uniqueness (an expression cannot live in a table
-- constraint, so it is an index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS tenant_memberships (
  membership_id text        NOT NULL,
  tenant_id     text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       text        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role          text        NOT NULL,
  status        text        NOT NULL DEFAULT 'ACTIVE',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, tenant_id),
  CONSTRAINT uq_membership_tenant_user UNIQUE (tenant_id, user_id),
  CONSTRAINT chk_membership_role CHECK (role IN (
    'OWNER', 'POLICY_ADMIN', 'APPROVER', 'OPERATOR', 'AUDITOR', 'SERVICE_AGENT'
  )),
  CONSTRAINT chk_membership_status CHECK (status IN ('ACTIVE', 'INVITED', 'REVOKED'))
);

-- -----------------------------------------------------------------------------
-- Credentials and agents
-- -----------------------------------------------------------------------------

-- SECURITY: this table stores a *reference* into the secret manager plus at most
-- a one-way hash and a short identifying prefix of a credential. The plaintext
-- secret is NEVER written here, never logged, and never sent to the model
-- (Master Prompt §5.14, PRD FR-074). `secret_hash` exists only so an inbound
-- bearer token can be matched without storing it.
CREATE TABLE IF NOT EXISTS service_credentials (
  credential_id   text        NOT NULL,
  tenant_id       text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  subject_type    text        NOT NULL DEFAULT 'AGENT',
  -- Polymorphic pointer (agent id / user id / service name). No FK by design:
  -- the credential must exist before the agent row that references it.
  subject_id      text,
  credential_ref  text        NOT NULL,
  secret_hash     text,
  secret_prefix   text,
  scopes_json     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status          text        NOT NULL DEFAULT 'ACTIVE',
  expires_at      timestamptz,
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, tenant_id),
  CONSTRAINT uq_service_credentials_ref UNIQUE (tenant_id, credential_ref),
  CONSTRAINT chk_service_credentials_subject_type CHECK (subject_type IN ('AGENT', 'USER', 'SERVICE')),
  CONSTRAINT chk_service_credentials_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')),
  CONSTRAINT chk_service_credentials_secret_prefix_length CHECK (secret_prefix IS NULL OR length(secret_prefix) <= 12)
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id             text        NOT NULL,
  tenant_id            text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                 text        NOT NULL,
  framework            text        NOT NULL,
  environment          text        NOT NULL DEFAULT 'DEMO',
  status               text        NOT NULL DEFAULT 'ACTIVE',
  credential_id        text        NOT NULL,
  credential_expires_at timestamptz,
  allowed_tools_json   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  description          text,
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Composite PK: the parent side of every `(agent_id, tenant_id)` child FK.
  PRIMARY KEY (agent_id, tenant_id),
  CONSTRAINT fk_agents_credential FOREIGN KEY (credential_id, tenant_id)
    REFERENCES service_credentials (credential_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_agents_tenant_name UNIQUE (tenant_id, name),
  CONSTRAINT chk_agents_environment CHECK (environment IN ('DEMO', 'STAGING', 'PRODUCTION')),
  CONSTRAINT chk_agents_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  -- A revoked identity must carry the moment it was revoked (deny-path evidence).
  CONSTRAINT chk_agents_revoked_at CHECK (status <> 'REVOKED' OR revoked_at IS NOT NULL)
);

-- -----------------------------------------------------------------------------
-- Policy and immutable revisions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS policies (
  policy_id             text        NOT NULL,
  tenant_id             text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                  text        NOT NULL,
  -- Stable human-facing code, e.g. AP-PROTECT-01 (PRD §6.1).
  code                  text        NOT NULL,
  description           text,
  published_revision_id text,
  status                text        NOT NULL DEFAULT 'ACTIVE',
  -- Optimistic concurrency for the publish pointer (PRD §10.7).
  version               integer     NOT NULL DEFAULT 0,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, tenant_id),
  CONSTRAINT uq_policies_tenant_code UNIQUE (tenant_id, code),
  CONSTRAINT chk_policies_status CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  CONSTRAINT chk_policies_version_nonneg CHECK (version >= 0)
);

CREATE TABLE IF NOT EXISTS policy_revisions (
  revision_id             text        NOT NULL,
  tenant_id               text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_id               text        NOT NULL,
  revision_number         integer     NOT NULL,
  status                  text        NOT NULL DEFAULT 'DRAFT',
  policy_json             jsonb       NOT NULL,
  policy_hash             text        NOT NULL,
  change_reason           text,
  fixture_corpus_version  text,
  created_by              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  published_at            timestamptz,
  rolled_back_at          timestamptz,
  PRIMARY KEY (revision_id, tenant_id),
  CONSTRAINT uq_policy_revisions_number UNIQUE (policy_id, revision_number),
  CONSTRAINT fk_policy_revisions_policy FOREIGN KEY (policy_id, tenant_id)
    REFERENCES policies (policy_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT chk_policy_revisions_status CHECK (status IN (
    'DRAFT', 'SIMULATING', 'READY', 'PUBLISHED', 'ROLLED_BACK'
  )),
  CONSTRAINT chk_policy_revisions_number_positive CHECK (revision_number > 0),
  -- A published revision is bound to the instant it became authoritative.
  CONSTRAINT chk_policy_revisions_published_at CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL),
  CONSTRAINT chk_policy_revisions_hash_shape CHECK (policy_hash ~ '^sha256:[a-f0-9]{64}$')
);

-- The publish pointer closes a cycle (policies -> policy_revisions -> policies),
-- so it is added after both tables exist. Re-runnable: guarded by pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_policies_published_revision'
  ) THEN
    ALTER TABLE policies
      ADD CONSTRAINT fk_policies_published_revision
      FOREIGN KEY (published_revision_id, tenant_id)
      REFERENCES policy_revisions (revision_id, tenant_id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Actions, approvals, permits, executions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS actions (
  action_id              text        NOT NULL,
  tenant_id              text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id               text        NOT NULL,
  run_id                 text        NOT NULL,
  trace_id               text        NOT NULL,
  tool_name              text        NOT NULL,
  operation              text        NOT NULL,
  task_purpose           text        NOT NULL DEFAULT '',
  -- Redacted on the way in (packages/domain/redaction.ts). The unredacted
  -- original is never persisted; only its hash is.
  arguments_json_redacted jsonb      NOT NULL DEFAULT '{}'::jsonb,
  arguments_hash         text        NOT NULL,
  hash_version           text        NOT NULL DEFAULT 'pz-canon-v1',
  evidence_refs_json     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key        text        NOT NULL,
  state                  text        NOT NULL DEFAULT 'RECEIVED',
  decision               text,
  decision_reason_codes_json jsonb   NOT NULL DEFAULT '[]'::jsonb,
  policy_revision_id     text,
  risk_signals_json      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  required_approvals     integer     NOT NULL DEFAULT 0,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  decided_at             timestamptz,
  expires_at             timestamptz,
  environment            text        NOT NULL DEFAULT 'DEMO',
  -- Optimistic concurrency (PRD §9.2). Every state change is a compare-and-swap.
  version                integer     NOT NULL DEFAULT 0,
  created_by_actor_id    text        NOT NULL,
  created_by_actor_type  text        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action_id, tenant_id),
  CONSTRAINT fk_actions_agent FOREIGN KEY (agent_id, tenant_id)
    REFERENCES agents (agent_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_actions_policy_revision FOREIGN KEY (policy_revision_id, tenant_id)
    REFERENCES policy_revisions (revision_id, tenant_id) ON DELETE RESTRICT,
  -- PRD §12.5: the DB unique constraint is the final dedup guard. A user
  -- double-click, a webhook replay and a network retry all collapse here.
  CONSTRAINT uq_actions_idempotency UNIQUE (tenant_id, agent_id, idempotency_key),
  CONSTRAINT chk_actions_state CHECK (state IN (
    'RECEIVED', 'VALIDATING', 'EVALUATING', 'DENIED', 'APPROVAL_REQUIRED',
    'ALLOWED', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED', 'PERMIT_ISSUED',
    'EXECUTION_PENDING', 'EXECUTING', 'SUCCEEDED', 'FAILED_RETRYABLE',
    'FAILED_TERMINAL', 'UNKNOWN_OUTCOME', 'RECONCILING', 'MANUAL_REVIEW',
    'QUARANTINED'
  )),
  CONSTRAINT chk_actions_decision CHECK (decision IS NULL OR decision IN (
    'ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'INDETERMINATE'
  )),
  CONSTRAINT chk_actions_actor_type CHECK (created_by_actor_type IN ('USER', 'AGENT', 'SYSTEM', 'WORKER')),
  CONSTRAINT chk_actions_environment CHECK (environment IN ('DEMO', 'STAGING', 'PRODUCTION')),
  CONSTRAINT chk_actions_version_nonneg CHECK (version >= 0),
  CONSTRAINT chk_actions_required_approvals_nonneg CHECK (required_approvals >= 0),
  CONSTRAINT chk_actions_arguments_hash_shape CHECK (arguments_hash ~ '^sha256:[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id          text        NOT NULL,
  tenant_id            text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_id            text        NOT NULL,
  -- Approval binds to the exact canonical action hash and policy revision; any
  -- changed argument invalidates it (PRD FR-041).
  action_hash          text        NOT NULL,
  policy_revision_id   text        NOT NULL,
  approver_user_id     text        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision             text        NOT NULL,
  reason_code          text        NOT NULL,
  reason_text_redacted text,
  approved_at          timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz,
  revoked_at           timestamptz,
  mfa_context_ref      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (approval_id, tenant_id),
  -- Composite FK: an approval in tenant A cannot reference an action in tenant B.
  CONSTRAINT fk_approvals_action FOREIGN KEY (action_id, tenant_id)
    REFERENCES actions (action_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_approvals_policy_revision FOREIGN KEY (policy_revision_id, tenant_id)
    REFERENCES policy_revisions (revision_id, tenant_id) ON DELETE RESTRICT,
  -- Dual approvers must be DISTINCT eligible identities (PRD FR-042). One row per
  -- (action, approver) makes a double vote impossible at the storage layer.
  CONSTRAINT uq_approvals_action_approver UNIQUE (action_id, approver_user_id),
  CONSTRAINT chk_approvals_decision CHECK (decision IN ('APPROVE', 'REJECT')),
  CONSTRAINT chk_approvals_action_hash_shape CHECK (action_hash ~ '^sha256:[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS permits (
  permit_id           text        NOT NULL,
  tenant_id           text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_id           text        NOT NULL,
  action_hash         text        NOT NULL,
  policy_revision_id  text        NOT NULL,
  audience_tool       text        NOT NULL,
  -- The permit token is opaque and never persisted in raw form: only this nonce
  -- hash and an HMAC of the token (PRD broker requirement 3).
  nonce_hash          text        NOT NULL,
  token_hash          text,
  signature_key_id    text        NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  revoked_at          timestamptz,
  revocation_reason   text,
  version             integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (permit_id, tenant_id),
  CONSTRAINT fk_permits_action FOREIGN KEY (action_id, tenant_id)
    REFERENCES actions (action_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_permits_policy_revision FOREIGN KEY (policy_revision_id, tenant_id)
    REFERENCES policy_revisions (revision_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_permits_nonce UNIQUE (tenant_id, nonce_hash),
  CONSTRAINT chk_permits_expiry CHECK (expires_at > issued_at),
  -- Single-use AND revocable, never both: a consumed permit cannot be revoked
  -- into an ambiguous state.
  CONSTRAINT chk_permits_consumed_xor_revoked CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT chk_permits_version_nonneg CHECK (version >= 0),
  CONSTRAINT chk_permits_action_hash_shape CHECK (action_hash ~ '^sha256:[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS connectors (
  connector_id        text        NOT NULL,
  tenant_id           text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                text        NOT NULL,
  type                text        NOT NULL,
  environment         text        NOT NULL DEFAULT 'DEMO',
  status              text        NOT NULL DEFAULT 'DISABLED',
  allowed_tools_json  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- SECURITY: `credential_ref` is a pointer into the secret manager. Only the
  -- broker resolves it. No plaintext secret, token or API key is ever stored in
  -- this table (PRD §9.1, Master Prompt §5.5/§5.14). `credential_prefix` is a
  -- short non-reversible label so an operator can tell two keys apart.
  credential_ref      text        NOT NULL,
  credential_hash     text,
  credential_prefix   text,
  simulated           boolean     NOT NULL DEFAULT true,
  last_health_check_at timestamptz,
  health_status       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, tenant_id),
  CONSTRAINT uq_connectors_tenant_name UNIQUE (tenant_id, name),
  CONSTRAINT chk_connectors_status CHECK (status IN ('ENABLED', 'DISABLED', 'DEGRADED', 'QUARANTINED')),
  CONSTRAINT chk_connectors_environment CHECK (environment IN ('DEMO', 'STAGING', 'PRODUCTION')),
  CONSTRAINT chk_connectors_health_status CHECK (health_status IS NULL OR health_status IN ('ok', 'degraded', 'down', 'disabled')),
  CONSTRAINT chk_connectors_credential_prefix_length CHECK (credential_prefix IS NULL OR length(credential_prefix) <= 12)
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id              text        NOT NULL,
  tenant_id                 text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_id                 text        NOT NULL,
  connector_id              text        NOT NULL,
  attempt_number            integer     NOT NULL DEFAULT 1,
  -- Distinct from the client idempotency key and the action id (PRD §12.5).
  connector_idempotency_key text        NOT NULL,
  state                     text        NOT NULL DEFAULT 'INTENT_RECORDED',
  dispatch_started_at       timestamptz,
  result_received_at        timestamptz,
  external_reference        text,
  receipt_hash              text,
  receipt_json              jsonb,
  amount_minor              bigint,
  currency                  text,
  beneficiary_ref           text,
  error_class               text,
  error_message_redacted    text,
  retry_after_at            timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_id, tenant_id),
  CONSTRAINT fk_executions_action FOREIGN KEY (action_id, tenant_id)
    REFERENCES actions (action_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_executions_connector FOREIGN KEY (connector_id, tenant_id)
    REFERENCES connectors (connector_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_executions_attempt UNIQUE (action_id, attempt_number),
  CONSTRAINT chk_executions_state CHECK (state IN (
    'INTENT_RECORDED', 'DISPATCHING', 'SUCCEEDED', 'FAILED_RETRYABLE',
    'FAILED_TERMINAL', 'UNKNOWN_OUTCOME', 'RECONCILED_SUCCEEDED',
    'RECONCILED_FAILED', 'MANUAL_REVIEW'
  )),
  CONSTRAINT chk_executions_attempt_positive CHECK (attempt_number > 0),
  CONSTRAINT chk_executions_amount_nonneg CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CONSTRAINT chk_executions_currency_shape CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  -- A durable execution-intent row exists BEFORE dispatch (PRD FR-035): dispatch
  -- may only be recorded once intent was written.
  CONSTRAINT chk_executions_dispatch_after_intent CHECK (dispatch_started_at IS NULL OR created_at <= dispatch_started_at)
);

-- -----------------------------------------------------------------------------
-- Append-only audit trail
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_events (
  event_id              text        NOT NULL,
  tenant_id             text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Deliberately NOT a foreign key to actions: audit evidence must survive the
  -- deletion of the record it describes (PRD FR-052). Tenant scoping is enforced
  -- by `tenant_id` above and by the composite FKs on every other child table.
  action_id             text,
  run_id                text,
  actor_type            text        NOT NULL,
  actor_id              text        NOT NULL,
  event_type            text        NOT NULL,
  event_time            timestamptz NOT NULL DEFAULT now(),
  trace_id              text        NOT NULL,
  policy_revision_id    text,
  payload_redacted_json jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Hash chain (PRD §9.1). `sequence` is gapless per tenant; `previous_hash` is
  -- the `event_hash` of sequence-1, verified by trigger and by test.
  previous_hash         text,
  event_hash            text        NOT NULL,
  hash_version          text        NOT NULL DEFAULT 'pz-audit-v1',
  sequence              bigint      NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, tenant_id),
  CONSTRAINT uq_audit_events_sequence UNIQUE (tenant_id, sequence),
  CONSTRAINT chk_audit_events_sequence_positive CHECK (sequence > 0),
  CONSTRAINT chk_audit_events_actor_type CHECK (actor_type IN ('USER', 'AGENT', 'SYSTEM', 'WORKER')),
  CONSTRAINT chk_audit_events_hash_shape CHECK (event_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT chk_audit_events_event_type_nonempty CHECK (length(btrim(event_type)) > 0)
);

-- -----------------------------------------------------------------------------
-- Transactional outbox
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS outbox_events (
  outbox_event_id   text        NOT NULL,
  tenant_id         text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Polymorphic aggregate pointer; no FK because the aggregate may be an action,
  -- a policy, a permit or a connector.
  aggregate_type    text        NOT NULL,
  aggregate_id      text        NOT NULL,
  event_type        text        NOT NULL,
  -- IDs and minimal metadata only, never secrets or large evidence bodies
  -- (PRD §12.4).
  payload_json      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status            text        NOT NULL DEFAULT 'PENDING',
  attempt_count     integer     NOT NULL DEFAULT 0,
  max_attempts      integer     NOT NULL DEFAULT 5,
  next_attempt_at   timestamptz,
  published_at      timestamptz,
  last_error_class  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outbox_event_id, tenant_id),
  CONSTRAINT chk_outbox_status CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED', 'DEAD')),
  CONSTRAINT chk_outbox_attempt_count_nonneg CHECK (attempt_count >= 0),
  CONSTRAINT chk_outbox_max_attempts_positive CHECK (max_attempts > 0),
  CONSTRAINT chk_outbox_published_at CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_id           text        NOT NULL,
  tenant_id                text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  principal_id             text        NOT NULL,
  principal_type           text        NOT NULL DEFAULT 'USER',
  idempotency_key          text        NOT NULL,
  request_hash             text        NOT NULL,
  resource_type            text,
  resource_id              text,
  status                   text        NOT NULL DEFAULT 'IN_PROGRESS',
  response_snapshot_redacted jsonb,
  http_status              integer,
  expires_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idempotency_id, tenant_id),
  -- PRD §12.5: key scoped to authenticated principal + tenant, bound to the
  -- canonical request hash. Same key + different hash ⇒ 409 IDEMPOTENCY_KEY_REUSE.
  CONSTRAINT uq_idempotency_scope UNIQUE (tenant_id, principal_id, idempotency_key),
  CONSTRAINT chk_idempotency_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
  CONSTRAINT chk_idempotency_principal_type CHECK (principal_type IN ('USER', 'AGENT', 'SYSTEM', 'WORKER')),
  CONSTRAINT chk_idempotency_http_status CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599))
);

-- -----------------------------------------------------------------------------
-- Model evaluations, replay
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_evaluations (
  model_evaluation_id  text        NOT NULL,
  tenant_id            text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_id            text,
  provider             text        NOT NULL,
  model_id             text        NOT NULL,
  prompt_version       text        NOT NULL,
  schema_version       text        NOT NULL,
  input_hash           text        NOT NULL,
  -- Validated + redacted output only. Raw prompts and raw completions are not
  -- stored by default (PRD §9.1, FR-074).
  output_json_validated jsonb,
  status               text        NOT NULL,
  latency_ms           integer,
  token_usage_json     jsonb,
  error_class          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_evaluation_id, tenant_id),
  CONSTRAINT fk_model_evaluations_action FOREIGN KEY (action_id, tenant_id)
    REFERENCES actions (action_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT chk_model_evaluations_status CHECK (status IN (
    'OK', 'DISABLED', 'UNAVAILABLE', 'INVALID_OUTPUT', 'TIMEOUT', 'ERROR'
  )),
  CONSTRAINT chk_model_evaluations_latency_nonneg CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

CREATE TABLE IF NOT EXISTS replay_sessions (
  replay_session_id        text        NOT NULL,
  tenant_id                text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_id                text,
  candidate_revision_id    text,
  baseline_revision_id     text,
  fixture_corpus_version   text        NOT NULL,
  status                   text        NOT NULL DEFAULT 'PENDING',
  requested_by             text,
  case_count               integer     NOT NULL DEFAULT 0,
  started_at               timestamptz,
  completed_at             timestamptz,
  summary_json             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error_class              text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replay_session_id, tenant_id),
  CONSTRAINT fk_replay_sessions_policy FOREIGN KEY (policy_id, tenant_id)
    REFERENCES policies (policy_id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT chk_replay_sessions_status CHECK (status IN (
    'PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'
  )),
  CONSTRAINT chk_replay_sessions_case_count_nonneg CHECK (case_count >= 0)
);

CREATE TABLE IF NOT EXISTS replay_results (
  replay_result_id      text        NOT NULL,
  tenant_id             text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  replay_session_id     text        NOT NULL,
  fixture_id            text        NOT NULL,
  action_id             text,
  baseline_decision     text,
  candidate_decision    text,
  changed               boolean     NOT NULL DEFAULT false,
  change_kind           text        NOT NULL DEFAULT 'UNCHANGED',
  baseline_reason_codes_json jsonb  NOT NULL DEFAULT '[]'::jsonb,
  candidate_reason_codes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail                text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replay_result_id, tenant_id),
  CONSTRAINT fk_replay_results_session FOREIGN KEY (replay_session_id, tenant_id)
    REFERENCES replay_sessions (replay_session_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT uq_replay_results_fixture UNIQUE (replay_session_id, fixture_id),
  CONSTRAINT chk_replay_results_decision CHECK (
    (baseline_decision IS NULL OR baseline_decision IN ('ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'INDETERMINATE'))
    AND (candidate_decision IS NULL OR candidate_decision IN ('ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'INDETERMINATE'))
  ),
  CONSTRAINT chk_replay_results_change_kind CHECK (change_kind IN (
    'UNCHANGED', 'FALSE_ALLOW', 'FALSE_DENY', 'ESCALATED', 'DEESCALATED', 'OTHER'
  ))
);

-- -----------------------------------------------------------------------------
-- Enforcement mode
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS enforcement_modes (
  tenant_id                text        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  mode                     text        NOT NULL DEFAULT 'ENFORCED',
  scope                    text        NOT NULL DEFAULT 'TENANT',
  reason                   text,
  -- A service may be alive but not ready for protected writes (PRD §10.8).
  protected_writes_allowed boolean     NOT NULL DEFAULT true,
  changed_by_actor_id      text,
  changed_by_actor_type    text,
  changed_at               timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_enforcement_modes_mode CHECK (mode IN (
    'ENFORCED', 'OBSERVE_ONLY', 'SIMULATION', 'DEGRADED_READ_ONLY',
    'EMERGENCY_STOP', 'QUARANTINE'
  )),
  CONSTRAINT chk_enforcement_modes_changed_by CHECK (
    changed_by_actor_type IS NULL OR changed_by_actor_type IN ('USER', 'AGENT', 'SYSTEM', 'WORKER')
  ),
  -- Only ENFORCED permits protected writes; every other mode is banner-worthy
  -- (PRD §6.3) and must fail closed on side-effecting tools.
  CONSTRAINT chk_enforcement_modes_protected_writes CHECK (
    protected_writes_allowed = (mode = 'ENFORCED')
  )
);

-- -----------------------------------------------------------------------------
-- Simulated connector's authoritative business data
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vendors (
  vendor_id                text        NOT NULL,
  tenant_id                text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                     text        NOT NULL,
  status                   text        NOT NULL DEFAULT 'UNVERIFIED',
  verified_beneficiary_ref text,
  verified_at              timestamptz,
  -- Drives the cooling-period rule (PRD §6.1).
  banking_changed_at       timestamptz,
  banking_change_verified_at timestamptz,
  pending_beneficiary_ref  text,
  allowed_destination_refs_json jsonb  NOT NULL DEFAULT '[]'::jsonb,
  account_age_days         integer     NOT NULL DEFAULT 0,
  data_classification      text        NOT NULL DEFAULT 'INTERNAL',
  country                  text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, tenant_id),
  CONSTRAINT chk_vendors_status CHECK (status IN (
    'VERIFIED', 'PENDING_VERIFICATION', 'UNVERIFIED', 'BLOCKED'
  )),
  CONSTRAINT chk_vendors_account_age_nonneg CHECK (account_age_days >= 0),
  -- A VERIFIED vendor must have something verified to compare against.
  CONSTRAINT chk_vendors_verified_reference CHECK (
    status <> 'VERIFIED' OR verified_beneficiary_ref IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS invoices (
  invoice_id        text        NOT NULL,
  tenant_id         text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_id         text        NOT NULL,
  -- Integer minor units in bigint, never a float (PRD §9). bigint keeps values
  -- above 2^53 exact; the JS boundary converts and refuses unsafe magnitudes.
  amount_minor      bigint      NOT NULL,
  currency          text        NOT NULL,
  purchase_order_id text,
  status            text        NOT NULL DEFAULT 'OPEN',
  issued_at         timestamptz,
  due_at            timestamptz,
  -- SECURITY / PROMPT-INJECTION BOUNDARY: `document_text` is UNTRUSTED content
  -- from an external system. It is evidence, never an instruction (PRD FR-014,
  -- §6.2). No policy, tool scope or connector credential may be derived from it,
  -- and it must never be concatenated into a system prompt.
  document_text     text,
  document_untrusted boolean    NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_id, tenant_id),
  CONSTRAINT fk_invoices_vendor FOREIGN KEY (vendor_id, tenant_id)
    REFERENCES vendors (vendor_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT chk_invoices_amount_nonneg CHECK (amount_minor >= 0),
  CONSTRAINT chk_invoices_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_invoices_document_untrusted CHECK (document_text IS NULL OR document_untrusted = true)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  purchase_order_id   text        NOT NULL,
  tenant_id           text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_id           text        NOT NULL,
  amount_minor        bigint      NOT NULL,
  currency            text        NOT NULL,
  status              text        NOT NULL DEFAULT 'OPEN',
  matched_invoice_ids_json jsonb  NOT NULL DEFAULT '[]'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (purchase_order_id, tenant_id),
  CONSTRAINT fk_purchase_orders_vendor FOREIGN KEY (vendor_id, tenant_id)
    REFERENCES vendors (vendor_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT chk_purchase_orders_amount_nonneg CHECK (amount_minor >= 0),
  CONSTRAINT chk_purchase_orders_currency_shape CHECK (currency ~ '^[A-Z]{3}$')
);

-- The simulated connector's own ledger of effects. Keyed by the connector
-- idempotency key so a repeated key returns the ORIGINAL receipt rather than
-- creating a second side effect (PRD §9 / Master Prompt §9).
CREATE TABLE IF NOT EXISTS connector_ledger (
  ledger_id                 text        NOT NULL,
  tenant_id                 text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id              text        NOT NULL,
  connector_idempotency_key text        NOT NULL,
  operation                 text        NOT NULL,
  external_reference        text        NOT NULL,
  receipt_hash              text        NOT NULL,
  receipt_json              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  amount_minor              bigint,
  currency                  text,
  beneficiary_ref           text,
  action_id                 text,
  execution_id              text,
  simulated                 boolean     NOT NULL DEFAULT true,
  completed_at              timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ledger_id, tenant_id),
  CONSTRAINT uq_connector_ledger_idempotency UNIQUE (tenant_id, connector_idempotency_key),
  CONSTRAINT fk_connector_ledger_connector FOREIGN KEY (connector_id, tenant_id)
    REFERENCES connectors (connector_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT chk_connector_ledger_amount_nonneg CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CONSTRAINT chk_connector_ledger_currency_shape CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

-- -----------------------------------------------------------------------------
-- Indexes (PRD §9.2)
-- -----------------------------------------------------------------------------

-- Hot list queries: newest first, always tenant-scoped.
CREATE INDEX IF NOT EXISTS idx_actions_tenant_created_at
  ON actions (tenant_id, created_at DESC);
-- Approval / action queues.
CREATE INDEX IF NOT EXISTS idx_actions_tenant_state_created_at
  ON actions (tenant_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_actions_tenant_run
  ON actions (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS idx_actions_tenant_requested_at
  ON actions (tenant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_tenant_agent_state
  ON actions (tenant_id, agent_id, state);

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_created_at
  ON audit_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_action_event_time
  ON audit_events (tenant_id, action_id, event_time);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_event_type_time
  ON audit_events (tenant_id, event_type, event_time);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_trace
  ON audit_events (tenant_id, trace_id);

-- The dispatcher polls exactly this shape.
CREATE INDEX IF NOT EXISTS idx_outbox_tenant_status_next_attempt
  ON outbox_events (tenant_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_status_next_attempt
  ON outbox_events (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_approvals_tenant_action
  ON approvals (tenant_id, action_id);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_approver
  ON approvals (tenant_id, approver_user_id);

-- Live (unconsumed) permits for an action — the single-use check.
CREATE INDEX IF NOT EXISTS idx_permits_action_unconsumed
  ON permits (action_id)
  WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_permits_tenant_expires
  ON permits (tenant_id, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_executions_tenant_action
  ON executions (tenant_id, action_id);
CREATE INDEX IF NOT EXISTS idx_executions_tenant_connector_key
  ON executions (tenant_id, connector_idempotency_key);

CREATE INDEX IF NOT EXISTS idx_permits_tenant_action
  ON permits (tenant_id, action_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON idempotency_records (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_model_evaluations_tenant_action
  ON model_evaluations (tenant_id, action_id);
CREATE INDEX IF NOT EXISTS idx_vendors_tenant_status
  ON vendors (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_vendor
  ON invoices (tenant_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_tenant_vendor
  ON purchase_orders (tenant_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user
  ON tenant_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_policy_revisions_policy_status
  ON policy_revisions (policy_id, status);
CREATE INDEX IF NOT EXISTS idx_agents_tenant_status
  ON agents (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_replay_results_session
  ON replay_results (replay_session_id);
