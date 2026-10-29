/**
 * @permitzero/db — Drizzle schema.
 *
 * This is the TYPED VIEW over tables whose authoritative DDL lives in
 * `infra/migrations/*.sql`. The migrations win: they carry the CHECK
 * constraints, composite foreign keys, triggers and indexes that make the
 * Master Prompt §5 invariants true even when application code is wrong. This
 * file exists so TypeScript callers cannot misspell a column, and so
 * `packages/db/test/schema-parity.test.ts` can prove the two have not drifted.
 *
 * Conventions:
 *  - snake_case in SQL, snake_case in the drizzle column name. Row objects are
 *    mapped to the camelCase domain records in `@permitzero/domain` by
 *    `./mappers.ts`.
 *  - Money is `bigint` with `mode: 'bigint'`. `mode: 'number'` silently loses
 *    precision above 2^53 (PRD §9: never IEEE binary float for money).
 *  - Enum-ish columns are `text` + a SQL CHECK against the exact domain enum,
 *    not PostgreSQL enums, so the CHECK list and `packages/domain/enums.ts`
 *    stay comparable in a test.
 *  - SECURITY: no column in this schema holds a plaintext secret. See
 *    `infra/migrations/0003_security_comments.sql`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { pgTable } from 'drizzle-orm/pg-core';
import type {
  ActionState,
  ActorType,
  AgentStatus,
  ApprovalDecision,
  ConnectorStatus,
  Decision,
  EnforcementMode,
  Environment,
  ExecutionState,
  OutboxStatus,
  PolicyRevisionStatus,
  Role,
  VendorStatus,
} from '@permitzero/domain';
import type { EvidenceRef, RiskSignal, ToolScope } from '@permitzero/domain';

/** UTC timestamps everywhere (PRD §9). */
const ts = (name: string) => timestamp(name, { withTimezone: true });
const tsNow = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Identity and tenancy
// ---------------------------------------------------------------------------

export const tenants = pgTable(
  'tenants',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status').notNull().default('ACTIVE').$type<'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'>(),
    defaultEnvironment: text('default_environment').notNull().default('DEMO').$type<Environment>(),
    /** True for the shipped demo corpus; forces the permanent DEMO banner. */
    synthetic: boolean('synthetic').notNull().default(false),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    unique('uq_tenants_slug').on(t.slug),
    check('chk_tenants_status', sql`${t.status} IN ('ACTIVE','SUSPENDED','ARCHIVED')`),
    check('chk_tenants_environment', sql`${t.defaultEnvironment} IN ('DEMO','STAGING','PRODUCTION')`),
    check('chk_tenants_name_nonempty', sql`length(btrim(${t.name})) > 0`),
  ],
);

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    identityProviderSubject: text('identity_provider_subject'),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('ACTIVE').$type<'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'>(),
    mfaEnrolledAt: ts('mfa_enrolled_at'),
    lastLoginAt: ts('last_login_at'),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    unique('uq_users_subject').on(t.identityProviderSubject),
    uniqueIndex('uq_users_email_lower').on(sql`lower(${t.email})`),
    check('chk_users_status', sql`${t.status} IN ('ACTIVE','SUSPENDED','DEACTIVATED')`),
  ],
);

export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    membershipId: text('membership_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<Role>(),
    status: text('status').notNull().default('ACTIVE').$type<'ACTIVE' | 'INVITED' | 'REVOKED'>(),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.tenantId] }),
    unique('uq_membership_tenant_user').on(t.tenantId, t.userId),
    check(
      'chk_membership_role',
      sql`${t.role} IN ('OWNER','POLICY_ADMIN','APPROVER','OPERATOR','AUDITOR','SERVICE_AGENT')`,
    ),
    check('chk_membership_status', sql`${t.status} IN ('ACTIVE','INVITED','REVOKED')`),
  ],
);

// ---------------------------------------------------------------------------
// Credentials and agents
// ---------------------------------------------------------------------------

/**
 * SECURITY: the TOTP shared secret of an account, ENCRYPTED.
 *
 * A TOTP secret is not a password hash: the server has to recompute a code
 * from it, so it cannot be one-way. It is therefore stored encrypted under a
 * key derived from the server secret, and the plaintext exists in exactly two
 * places — the enrolment response that hands it to the authenticator app, and
 * the authenticator app itself.
 *
 * One row per user, not per (user, tenant): the secret belongs to the person,
 * and an account that belongs to several tenants still has ONE authenticator
 * entry. The tenant column says which tenant the row was enrolled under, and
 * is the boundary row-level security enforces.
 */
export const mfaSecrets = pgTable(
  'mfa_secrets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** `v1.<iv>.<tag>.<ciphertext>`, base64url. Never the plaintext. */
    secretEncrypted: text('secret_encrypted').notNull(),
    createdAt: tsNow('created_at'),
    /** When this account last completed a step-up verification. */
    lastVerifiedAt: ts('last_verified_at'),
    /**
     * Keyed fingerprint of the last TOTP code this account spent. A code is
     * good for a whole thirty-second step, so without this a captured code
     * could be presented twice; with it, the second presentation is refused.
     */
    lastCodeHash: text('last_code_hash'),
  },
  (t) => [
    uniqueIndex('uq_mfa_secrets_user').on(t.userId),
    check(
      'chk_mfa_secrets_encrypted_shape',
      sql`${t.secretEncrypted} ~ '^v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$'`,
    ),
  ],
);

/**
 * SECURITY: stores a secret-manager REFERENCE plus at most a one-way hash and a
 * short prefix. The plaintext credential never reaches this table.
 */
export const serviceCredentials = pgTable(
  'service_credentials',
  {
    credentialId: text('credential_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    subjectType: text('subject_type').notNull().default('AGENT').$type<'AGENT' | 'USER' | 'SERVICE'>(),
    subjectId: text('subject_id'),
    credentialRef: text('credential_ref').notNull(),
    secretHash: text('secret_hash'),
    secretPrefix: text('secret_prefix'),
    scopesJson: jsonb('scopes_json')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<readonly string[]>(),
    status: text('status').notNull().default('ACTIVE').$type<'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED'>(),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    lastUsedAt: ts('last_used_at'),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.credentialId, t.tenantId] }),
    unique('uq_service_credentials_ref').on(t.tenantId, t.credentialRef),
    // One live credential per (tenant, name); revoked names may be re-issued.
    uniqueIndex('uq_service_credentials_active_name')
      .on(t.tenantId, t.name)
      .where(sql`${t.status} = 'ACTIVE'`),
    check('chk_service_credentials_subject_type', sql`${t.subjectType} IN ('AGENT','USER','SERVICE')`),
    check('chk_service_credentials_status', sql`${t.status} IN ('ACTIVE','SUSPENDED','REVOKED','EXPIRED')`),
    check(
      'chk_service_credentials_secret_prefix_length',
      sql`${t.secretPrefix} IS NULL OR length(${t.secretPrefix}) <= 12`,
    ),
  ],
);

export const agents = pgTable(
  'agents',
  {
    agentId: text('agent_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    framework: text('framework').notNull(),
    environment: text('environment').notNull().default('DEMO').$type<Environment>(),
    status: text('status').notNull().default('ACTIVE').$type<AgentStatus>(),
    credentialId: text('credential_id').notNull(),
    credentialExpiresAt: ts('credential_expires_at'),
    allowedToolsJson: jsonb('allowed_tools_json')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<readonly ToolScope[]>(),
    description: text('description'),
    revokedAt: ts('revoked_at'),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.tenantId] }),
    unique('uq_agents_tenant_name').on(t.tenantId, t.name),
    index('idx_agents_tenant_status').on(t.tenantId, t.status),
    check('chk_agents_environment', sql`${t.environment} IN ('DEMO','STAGING','PRODUCTION')`),
    check('chk_agents_status', sql`${t.status} IN ('ACTIVE','SUSPENDED','REVOKED')`),
    check('chk_agents_revoked_at', sql`${t.status} <> 'REVOKED' OR ${t.revokedAt} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Policy and immutable revisions
// ---------------------------------------------------------------------------

export const policies = pgTable(
  'policies',
  {
    policyId: text('policy_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code').notNull(),
    description: text('description'),
    publishedRevisionId: text('published_revision_id'),
    status: text('status').notNull().default('ACTIVE').$type<'DRAFT' | 'ACTIVE' | 'ARCHIVED'>(),
    /** Optimistic concurrency for the publish pointer (PRD §10.7). */
    version: integer('version').notNull().default(0),
    createdBy: text('created_by'),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.policyId, t.tenantId] }),
    unique('uq_policies_tenant_code').on(t.tenantId, t.code),
    check('chk_policies_status', sql`${t.status} IN ('DRAFT','ACTIVE','ARCHIVED')`),
    check('chk_policies_version_nonneg', sql`${t.version} >= 0`),
  ],
);

export const policyRevisions = pgTable(
  'policy_revisions',
  {
    revisionId: text('revision_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    policyId: text('policy_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    status: text('status').notNull().default('DRAFT').$type<PolicyRevisionStatus>(),
    policyJson: jsonb('policy_json').notNull().$type<Record<string, unknown>>(),
    policyHash: text('policy_hash').notNull(),
    changeReason: text('change_reason'),
    fixtureCorpusVersion: text('fixture_corpus_version'),
    createdBy: text('created_by'),
    createdAt: tsNow('created_at'),
    publishedAt: ts('published_at'),
    rolledBackAt: ts('rolled_back_at'),
  },
  (t) => [
    primaryKey({ columns: [t.revisionId, t.tenantId] }),
    unique('uq_policy_revisions_number').on(t.policyId, t.revisionNumber),
    index('idx_policy_revisions_policy_status').on(t.policyId, t.status),
    check('chk_policy_revisions_status', sql`${t.status} IN ('DRAFT','SIMULATING','READY','PUBLISHED','ROLLED_BACK')`),
    check('chk_policy_revisions_number_positive', sql`${t.revisionNumber} > 0`),
    check('chk_policy_revisions_published_at', sql`${t.status} <> 'PUBLISHED' OR ${t.publishedAt} IS NOT NULL`),
    check('chk_policy_revisions_hash_shape', sql`${t.policyHash} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);

// ---------------------------------------------------------------------------
// Actions, approvals, permits, executions, connectors
// ---------------------------------------------------------------------------

export const actions = pgTable(
  'actions',
  {
    actionId: text('action_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    runId: text('run_id').notNull(),
    traceId: text('trace_id').notNull(),
    toolName: text('tool_name').notNull(),
    operation: text('operation').notNull(),
    taskPurpose: text('task_purpose').notNull().default(''),
    argumentsJsonRedacted: jsonb('arguments_json_redacted')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    argumentsHash: text('arguments_hash').notNull(),
    hashVersion: text('hash_version').notNull().default('pz-canon-v1'),
    evidenceRefsJson: jsonb('evidence_refs_json')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<readonly EvidenceRef[]>(),
    idempotencyKey: text('idempotency_key').notNull(),
    state: text('state').notNull().default('RECEIVED').$type<ActionState>(),
    decision: text('decision').$type<Decision | null>(),
    decisionReasonCodesJson: jsonb('decision_reason_codes_json')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<readonly string[]>(),
    policyRevisionId: text('policy_revision_id'),
    riskSignalsJson: jsonb('risk_signals_json')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<readonly RiskSignal[]>(),
    requiredApprovals: integer('required_approvals').notNull().default(0),
    requestedAt: tsNow('requested_at'),
    decidedAt: ts('decided_at'),
    expiresAt: ts('expires_at'),
    environment: text('environment').notNull().default('DEMO').$type<Environment>(),
    version: integer('version').notNull().default(0),
    createdByActorId: text('created_by_actor_id').notNull(),
    createdByActorType: text('created_by_actor_type').notNull().$type<ActorType>(),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.actionId, t.tenantId] }),
    unique('uq_actions_idempotency').on(t.tenantId, t.agentId, t.idempotencyKey),
    index('idx_actions_tenant_created_at').on(t.tenantId, sql`${t.createdAt} DESC`),
    index('idx_actions_tenant_state_created_at').on(t.tenantId, t.state, t.createdAt),
    index('idx_actions_tenant_run').on(t.tenantId, t.runId),
    index('idx_actions_tenant_requested_at').on(t.tenantId, sql`${t.requestedAt} DESC`),
    index('idx_actions_tenant_agent_state').on(t.tenantId, t.agentId, t.state),
    check(
      'chk_actions_state',
      sql`${t.state} IN (
        'RECEIVED','VALIDATING','EVALUATING','DENIED','APPROVAL_REQUIRED',
        'ALLOWED','APPROVED','REJECTED','EXPIRED','REVOKED','PERMIT_ISSUED',
        'EXECUTION_PENDING','EXECUTING','SUCCEEDED','FAILED_RETRYABLE',
        'FAILED_TERMINAL','UNKNOWN_OUTCOME','RECONCILING','MANUAL_REVIEW',
        'QUARANTINED')`,
    ),
    check(
      'chk_actions_decision',
      sql`${t.decision} IS NULL OR ${t.decision} IN ('ALLOW','DENY','REQUIRE_APPROVAL','INDETERMINATE')`,
    ),
    check('chk_actions_actor_type', sql`${t.createdByActorType} IN ('USER','AGENT','SYSTEM','WORKER')`),
    check('chk_actions_environment', sql`${t.environment} IN ('DEMO','STAGING','PRODUCTION')`),
    check('chk_actions_version_nonneg', sql`${t.version} >= 0`),
    check('chk_actions_required_approvals_nonneg', sql`${t.requiredApprovals} >= 0`),
    check('chk_actions_arguments_hash_shape', sql`${t.argumentsHash} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    approvalId: text('approval_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actionId: text('action_id').notNull(),
    actionHash: text('action_hash').notNull(),
    policyRevisionId: text('policy_revision_id').notNull(),
    approverUserId: text('approver_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decision: text('decision').notNull().$type<ApprovalDecision>(),
    reasonCode: text('reason_code').notNull(),
    reasonTextRedacted: text('reason_text_redacted'),
    approvedAt: tsNow('approved_at'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    mfaContextRef: text('mfa_context_ref'),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.approvalId, t.tenantId] }),
    unique('uq_approvals_action_approver').on(t.actionId, t.approverUserId),
    index('idx_approvals_tenant_action').on(t.tenantId, t.actionId),
    index('idx_approvals_tenant_approver').on(t.tenantId, t.approverUserId),
    check('chk_approvals_decision', sql`${t.decision} IN ('APPROVE','REJECT')`),
    check('chk_approvals_action_hash_shape', sql`${t.actionHash} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);

export const permits = pgTable(
  'permits',
  {
    permitId: text('permit_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actionId: text('action_id').notNull(),
    actionHash: text('action_hash').notNull(),
    policyRevisionId: text('policy_revision_id').notNull(),
    audienceTool: text('audience_tool').notNull(),
    nonceHash: text('nonce_hash').notNull(),
    /** HMAC of the opaque token; the raw token is never persisted. */
    tokenHash: text('token_hash'),
    signatureKeyId: text('signature_key_id').notNull(),
    issuedAt: tsNow('issued_at'),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    revokedAt: ts('revoked_at'),
    revocationReason: text('revocation_reason'),
    version: integer('version').notNull().default(0),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.permitId, t.tenantId] }),
    unique('uq_permits_nonce').on(t.tenantId, t.nonceHash),
    // Single-use check: only live permits are indexed.
    index('idx_permits_action_unconsumed')
      .on(t.actionId)
      .where(sql`${t.consumedAt} IS NULL`),
    index('idx_permits_tenant_expires')
      .on(t.tenantId, t.expiresAt)
      .where(sql`${t.consumedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    index('idx_permits_tenant_action').on(t.tenantId, t.actionId),
    check('chk_permits_expiry', sql`${t.expiresAt} > ${t.issuedAt}`),
    check('chk_permits_consumed_xor_revoked', sql`${t.consumedAt} IS NULL OR ${t.revokedAt} IS NULL`),
    check('chk_permits_version_nonneg', sql`${t.version} >= 0`),
    check('chk_permits_action_hash_shape', sql`${t.actionHash} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);

/**
 * SECURITY: `credentialRef` points into a secret manager and is resolved by the
 * broker alone. No plaintext secret, token or API key lives in this table.
 */
export const connectors = pgTable(
  'connectors',
  {
    connectorId: text('connector_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    environment: text('environment').notNull().default('DEMO').$type<Environment>(),
    status: text('status').notNull().default('DISABLED').$type<ConnectorStatus>(),
    allowedToolsJson: jsonb('allowed_tools_json')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<readonly string[]>(),
    credentialRef: text('credential_ref').notNull(),
    credentialHash: text('credential_hash'),
    credentialPrefix: text('credential_prefix'),
    simulated: boolean('simulated').notNull().default(true),
    lastHealthCheckAt: ts('last_health_check_at'),
    healthStatus: text('health_status').$type<'ok' | 'degraded' | 'down' | 'disabled' | null>(),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.connectorId, t.tenantId] }),
    unique('uq_connectors_tenant_name').on(t.tenantId, t.name),
    check('chk_connectors_status', sql`${t.status} IN ('ENABLED','DISABLED','DEGRADED','QUARANTINED')`),
    check('chk_connectors_environment', sql`${t.environment} IN ('DEMO','STAGING','PRODUCTION')`),
    check(
      'chk_connectors_health_status',
      sql`${t.healthStatus} IS NULL OR ${t.healthStatus} IN ('ok','degraded','down','disabled')`,
    ),
    check(
      'chk_connectors_credential_prefix_length',
      sql`${t.credentialPrefix} IS NULL OR length(${t.credentialPrefix}) <= 12`,
    ),
  ],
);

export const executions = pgTable(
  'executions',
  {
    executionId: text('execution_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actionId: text('action_id').notNull(),
    connectorId: text('connector_id').notNull(),
    attemptNumber: integer('attempt_number').notNull().default(1),
    connectorIdempotencyKey: text('connector_idempotency_key').notNull(),
    state: text('state').notNull().default('INTENT_RECORDED').$type<ExecutionState>(),
    dispatchStartedAt: ts('dispatch_started_at'),
    resultReceivedAt: ts('result_received_at'),
    externalReference: text('external_reference'),
    receiptHash: text('receipt_hash'),
    receiptJson: jsonb('receipt_json').$type<Record<string, unknown> | null>(),
    /** Integer minor units, bigint. Never a float. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    currency: text('currency'),
    beneficiaryRef: text('beneficiary_ref'),
    errorClass: text('error_class'),
    errorMessageRedacted: text('error_message_redacted'),
    retryAfterAt: ts('retry_after_at'),
    /** Provenance: which permit authorized this attempt (never the token). */
    permitId: text('permit_id'),
    permitNonceHash: text('permit_nonce_hash'),
    actorId: text('actor_id').notNull(),
    traceId: text('trace_id').notNull(),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.executionId, t.tenantId] }),
    unique('uq_executions_attempt').on(t.actionId, t.attemptNumber),
    index('idx_executions_tenant_action').on(t.tenantId, t.actionId),
    index('idx_executions_tenant_connector_key').on(t.tenantId, t.connectorIdempotencyKey),
    check(
      'chk_executions_state',
      sql`${t.state} IN (
        'INTENT_RECORDED','DISPATCHING','SUCCEEDED','FAILED_RETRYABLE',
        'FAILED_TERMINAL','UNKNOWN_OUTCOME','RECONCILED_SUCCEEDED',
        'RECONCILED_FAILED','MANUAL_REVIEW')`,
    ),
    check('chk_executions_attempt_positive', sql`${t.attemptNumber} > 0`),
    check('chk_executions_amount_nonneg', sql`${t.amountMinor} IS NULL OR ${t.amountMinor} >= 0`),
    check('chk_executions_currency_shape', sql`${t.currency} IS NULL OR ${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'chk_executions_dispatch_after_intent',
      sql`${t.dispatchStartedAt} IS NULL OR ${t.createdAt} <= ${t.dispatchStartedAt}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Append-only audit trail
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  'audit_events',
  {
    eventId: text('event_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Deliberately not a foreign key: audit evidence outlives the record it
     * describes (PRD FR-052). */
    actionId: text('action_id'),
    runId: text('run_id'),
    actorType: text('actor_type').notNull().$type<ActorType>(),
    actorId: text('actor_id').notNull(),
    eventType: text('event_type').notNull(),
    eventTime: tsNow('event_time'),
    traceId: text('trace_id').notNull(),
    policyRevisionId: text('policy_revision_id'),
    payloadRedactedJson: jsonb('payload_redacted_json')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    previousHash: text('previous_hash'),
    eventHash: text('event_hash').notNull(),
    hashVersion: text('hash_version').notNull().default('pz-audit-v1'),
    sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
    /** When this event becomes eligible for the retention sweep. */
    expiresAt: ts('expires_at'),
    /** When it was actually purged. A purged event keeps its row so the hash
     * chain stays gapless and verifiable across the purge. */
    purgedAt: ts('purged_at'),
    createdAt: tsNow('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.tenantId] }),
    unique('uq_audit_events_sequence').on(t.tenantId, t.sequence),
    index('idx_audit_events_tenant_created_at').on(t.tenantId, sql`${t.createdAt} DESC`),
    index('idx_audit_events_tenant_action_event_time').on(t.tenantId, t.actionId, t.eventTime),
    index('idx_audit_events_tenant_event_type_time').on(t.tenantId, t.eventType, t.eventTime),
    index('idx_audit_events_tenant_trace').on(t.tenantId, t.traceId),
    check('chk_audit_events_sequence_positive', sql`${t.sequence} > 0`),
    check('chk_audit_events_actor_type', sql`${t.actorType} IN ('USER','AGENT','SYSTEM','WORKER')`),
    check('chk_audit_events_hash_shape', sql`${t.eventHash} ~ '^sha256:[a-f0-9]{64}$'`),
    check('chk_audit_events_event_type_nonempty', sql`length(btrim(${t.eventType})) > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Outbox, idempotency, model evaluations, replay
// ---------------------------------------------------------------------------

export const outboxEvents = pgTable(
  'outbox_events',
  {
    outboxEventId: text('outbox_event_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    queueName: text('queue_name').notNull().default('pz.outbox'),
    payloadJson: jsonb('payload_json')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    status: text('status').notNull().default('PENDING').$type<OutboxStatus>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: ts('next_attempt_at'),
    publishedAt: ts('published_at'),
    lastErrorClass: text('last_error_class'),
    /** When this row becomes eligible for the retention sweep. */
    expiresAt: ts('expires_at'),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.outboxEventId, t.tenantId] }),
    index('idx_outbox_tenant_status_next_attempt').on(t.tenantId, t.status, t.nextAttemptAt),
    index('idx_outbox_status_next_attempt').on(t.status, t.nextAttemptAt),
    check('chk_outbox_status', sql`${t.status} IN ('PENDING','PUBLISHED','FAILED','DEAD')`),
    check(
      'chk_outbox_queue_name',
      sql`${t.queueName} IN ('pz.outbox','pz.model-analysis','pz.reconciliation','pz.replay','pz.dlq')`,
    ),
    check('chk_outbox_attempt_count_nonneg', sql`${t.attemptCount} >= 0`),
    check('chk_outbox_max_attempts_positive', sql`${t.maxAttempts} > 0`),
    check('chk_outbox_published_at', sql`${t.status} <> 'PUBLISHED' OR ${t.publishedAt} IS NOT NULL`),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    idempotencyId: text('idempotency_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    principalType: text('principal_type').notNull().default('USER').$type<ActorType>(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    status: text('status').notNull().default('IN_PROGRESS').$type<'IN_PROGRESS' | 'COMPLETED' | 'FAILED'>(),
    responseSnapshotRedacted: jsonb('response_snapshot_redacted').$type<Record<string, unknown> | null>(),
    httpStatus: integer('http_status'),
    expiresAt: ts('expires_at'),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.idempotencyId, t.tenantId] }),
    unique('uq_idempotency_scope').on(t.tenantId, t.principalId, t.idempotencyKey),
    index('idx_idempotency_expires')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL`),
    check('chk_idempotency_status', sql`${t.status} IN ('IN_PROGRESS','COMPLETED','FAILED')`),
    check('chk_idempotency_principal_type', sql`${t.principalType} IN ('USER','AGENT','SYSTEM','WORKER')`),
    check(
      'chk_idempotency_http_status',
      sql`${t.httpStatus} IS NULL OR (${t.httpStatus} >= 100 AND ${t.httpStatus} <= 599)`,
    ),
  ],
);

export const modelEvaluations = pgTable(
  'model_evaluations',
  {
    modelEvaluationId: text('model_evaluation_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actionId: text('action_id'),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    inputHash: text('input_hash').notNull(),
    outputJsonValidated: jsonb('output_json_validated').$type<Record<string, unknown> | null>(),
    status: text('status')
      .notNull()
      .$type<'OK' | 'DISABLED' | 'UNAVAILABLE' | 'INVALID_OUTPUT' | 'TIMEOUT' | 'ERROR'>(),
    latencyMs: integer('latency_ms'),
    tokenUsageJson: jsonb('token_usage_json').$type<Record<string, number> | null>(),
    errorClass: text('error_class'),
    createdAt: tsNow('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.modelEvaluationId, t.tenantId] }),
    index('idx_model_evaluations_tenant_action').on(t.tenantId, t.actionId),
    check(
      'chk_model_evaluations_status',
      sql`${t.status} IN ('OK','DISABLED','UNAVAILABLE','INVALID_OUTPUT','TIMEOUT','ERROR')`,
    ),
    check('chk_model_evaluations_latency_nonneg', sql`${t.latencyMs} IS NULL OR ${t.latencyMs} >= 0`),
  ],
);

export const replaySessions = pgTable(
  'replay_sessions',
  {
    replaySessionId: text('replay_session_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    policyId: text('policy_id'),
    candidateRevisionId: text('candidate_revision_id'),
    baselineRevisionId: text('baseline_revision_id'),
    fixtureCorpusVersion: text('fixture_corpus_version').notNull(),
    status: text('status')
      .notNull()
      .default('PENDING')
      .$type<'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'>(),
    requestedBy: text('requested_by'),
    caseCount: integer('case_count').notNull().default(0),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    summaryJson: jsonb('summary_json')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    errorClass: text('error_class'),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.replaySessionId, t.tenantId] }),
    check('chk_replay_sessions_status', sql`${t.status} IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')`),
    check('chk_replay_sessions_case_count_nonneg', sql`${t.caseCount} >= 0`),
  ],
);

export const replayResults = pgTable(
  'replay_results',
  {
    replayResultId: text('replay_result_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    replaySessionId: text('replay_session_id').notNull(),
    fixtureId: text('fixture_id').notNull(),
    actionId: text('action_id'),
    baselineDecision: text('baseline_decision').$type<Decision | null>(),
    candidateDecision: text('candidate_decision').$type<Decision | null>(),
    changed: boolean('changed').notNull().default(false),
    changeKind: text('change_kind')
      .notNull()
      .default('UNCHANGED')
      .$type<'UNCHANGED' | 'FALSE_ALLOW' | 'FALSE_DENY' | 'ESCALATED' | 'DEESCALATED' | 'OTHER'>(),
    baselineReasonCodesJson: jsonb('baseline_reason_codes_json')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<readonly string[]>(),
    candidateReasonCodesJson: jsonb('candidate_reason_codes_json')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<readonly string[]>(),
    detail: text('detail'),
    createdAt: tsNow('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.replayResultId, t.tenantId] }),
    unique('uq_replay_results_fixture').on(t.replaySessionId, t.fixtureId),
    index('idx_replay_results_session').on(t.replaySessionId),
    check(
      'chk_replay_results_decision',
      sql`(${t.baselineDecision} IS NULL OR ${t.baselineDecision} IN ('ALLOW','DENY','REQUIRE_APPROVAL','INDETERMINATE'))
           AND (${t.candidateDecision} IS NULL OR ${t.candidateDecision} IN ('ALLOW','DENY','REQUIRE_APPROVAL','INDETERMINATE'))`,
    ),
    check(
      'chk_replay_results_change_kind',
      sql`${t.changeKind} IN ('UNCHANGED','FALSE_ALLOW','FALSE_DENY','ESCALATED','DEESCALATED','OTHER')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Enforcement mode
// ---------------------------------------------------------------------------

export const enforcementModes = pgTable(
  'enforcement_modes',
  {
    tenantId: text('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull().default('ENFORCED').$type<EnforcementMode>(),
    scope: text('scope').notNull().default('TENANT'),
    reason: text('reason'),
    protectedWritesAllowed: boolean('protected_writes_allowed').notNull().default(true),
    changedByActorId: text('changed_by_actor_id'),
    changedByActorType: text('changed_by_actor_type').$type<ActorType | null>(),
    changedAt: tsNow('changed_at'),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    check(
      'chk_enforcement_modes_mode',
      sql`${t.mode} IN ('ENFORCED','OBSERVE_ONLY','SIMULATION','DEGRADED_READ_ONLY','EMERGENCY_STOP','QUARANTINE')`,
    ),
    check(
      'chk_enforcement_modes_changed_by',
      sql`${t.changedByActorType} IS NULL OR ${t.changedByActorType} IN ('USER','AGENT','SYSTEM','WORKER')`,
    ),
    check('chk_enforcement_modes_protected_writes', sql`${t.protectedWritesAllowed} = (${t.mode} = 'ENFORCED')`),
  ],
);

// ---------------------------------------------------------------------------
// Simulated connector's authoritative business data
// ---------------------------------------------------------------------------

export const vendors = pgTable(
  'vendors',
  {
    vendorId: text('vendor_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').notNull().default('UNVERIFIED').$type<VendorStatus>(),
    verifiedBeneficiaryRef: text('verified_beneficiary_ref'),
    verifiedAt: ts('verified_at'),
    bankingChangedAt: ts('banking_changed_at'),
    bankingChangeVerifiedAt: ts('banking_change_verified_at'),
    pendingBeneficiaryRef: text('pending_beneficiary_ref'),
    allowedDestinationRefsJson: jsonb('allowed_destination_refs_json')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<readonly string[]>(),
    accountAgeDays: integer('account_age_days').notNull().default(0),
    dataClassification: text('data_classification').notNull().default('INTERNAL'),
    country: text('country'),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.vendorId, t.tenantId] }),
    index('idx_vendors_tenant_status').on(t.tenantId, t.status),
    check('chk_vendors_status', sql`${t.status} IN ('VERIFIED','PENDING_VERIFICATION','UNVERIFIED','BLOCKED')`),
    check('chk_vendors_account_age_nonneg', sql`${t.accountAgeDays} >= 0`),
    check('chk_vendors_verified_reference', sql`${t.status} <> 'VERIFIED' OR ${t.verifiedBeneficiaryRef} IS NOT NULL`),
  ],
);

export const invoices = pgTable(
  'invoices',
  {
    invoiceId: text('invoice_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    vendorId: text('vendor_id').notNull(),
    /** Integer minor units, bigint — exact above 2^53. Never a float. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    purchaseOrderId: text('purchase_order_id'),
    status: text('status').notNull().default('OPEN'),
    issuedAt: ts('issued_at'),
    dueAt: ts('due_at'),
    /** UNTRUSTED external content: evidence, never an instruction (PRD FR-014). */
    documentText: text('document_text'),
    documentUntrusted: boolean('document_untrusted').notNull().default(true),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.invoiceId, t.tenantId] }),
    index('idx_invoices_tenant_vendor').on(t.tenantId, t.vendorId),
    check('chk_invoices_amount_nonneg', sql`${t.amountMinor} >= 0`),
    check('chk_invoices_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('chk_invoices_document_untrusted', sql`${t.documentText} IS NULL OR ${t.documentUntrusted} = true`),
  ],
);

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    purchaseOrderId: text('purchase_order_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    vendorId: text('vendor_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    status: text('status').notNull().default('OPEN'),
    matchedInvoiceIdsJson: jsonb('matched_invoice_ids_json')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<readonly string[]>(),
    createdAt: tsNow('created_at'),
    updatedAt: tsNow('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.purchaseOrderId, t.tenantId] }),
    index('idx_purchase_orders_tenant_vendor').on(t.tenantId, t.vendorId),
    check('chk_purchase_orders_amount_nonneg', sql`${t.amountMinor} >= 0`),
    check('chk_purchase_orders_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const connectorLedger = pgTable(
  'connector_ledger',
  {
    ledgerId: text('ledger_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id').notNull(),
    connectorIdempotencyKey: text('connector_idempotency_key').notNull(),
    operation: text('operation').notNull(),
    externalReference: text('external_reference').notNull(),
    receiptHash: text('receipt_hash').notNull(),
    receiptJson: jsonb('receipt_json')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    currency: text('currency'),
    beneficiaryRef: text('beneficiary_ref'),
    actionId: text('action_id'),
    executionId: text('execution_id'),
    detailJsonRedacted: jsonb('detail_json_redacted')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    simulated: boolean('simulated').notNull().default(true),
    completedAt: tsNow('completed_at'),
    createdAt: tsNow('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.ledgerId, t.tenantId] }),
    unique('uq_connector_ledger_idempotency').on(t.tenantId, t.connectorIdempotencyKey),
    check('chk_connector_ledger_amount_nonneg', sql`${t.amountMinor} IS NULL OR ${t.amountMinor} >= 0`),
    check('chk_connector_ledger_currency_shape', sql`${t.currency} IS NULL OR ${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const connectorDispatches = pgTable(
  'connector_dispatches',
  {
    dispatchId: text('dispatch_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectorIdempotencyKey: text('connector_idempotency_key').notNull(),
    operation: text('operation').notNull(),
    startedAt: ts('started_at').notNull(),
    completedAt: ts('completed_at'),
    outcome: text('outcome'),
    createdAt: tsNow('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.dispatchId, t.tenantId] }),
    index('idx_dispatches_tenant_key').on(t.tenantId, t.connectorIdempotencyKey),
    check('chk_dispatches_completed', sql`${t.completedAt} IS NULL OR ${t.completedAt} >= ${t.startedAt}`),
  ],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type TenantRow = typeof tenants.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type MfaSecretRow = typeof mfaSecrets.$inferSelect;
export type TenantMembershipRow = typeof tenantMemberships.$inferSelect;
export type ServiceCredentialRow = typeof serviceCredentials.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type PolicyRow = typeof policies.$inferSelect;
export type PolicyRevisionRow = typeof policyRevisions.$inferSelect;
export type ActionRow = typeof actions.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type PermitRow = typeof permits.$inferSelect;
export type ConnectorRow = typeof connectors.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type OutboxEventRow = typeof outboxEvents.$inferSelect;
export type IdempotencyRecordRow = typeof idempotencyRecords.$inferSelect;
export type ModelEvaluationRow = typeof modelEvaluations.$inferSelect;
export type ReplaySessionRow = typeof replaySessions.$inferSelect;
export type ReplayResultRow = typeof replayResults.$inferSelect;
export type EnforcementModeRow = typeof enforcementModes.$inferSelect;
export type VendorRow = typeof vendors.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type PurchaseOrderRow = typeof purchaseOrders.$inferSelect;
export type ConnectorLedgerRow = typeof connectorLedger.$inferSelect;
export type ConnectorDispatchRow = typeof connectorDispatches.$inferSelect;

/**
 * A legal hold: this tenant's data must not be deleted, whatever the
 * retention window says.
 *
 * The hold is a row rather than a flag on the tenant because holds are
 * scoped and reasoned — which matter, are released by a named operator, and
 * leave a record. A deletion that leaves no trace is a deletion nobody can
 * be asked about later.
 */
export const legalHolds = pgTable(
  'legal_holds',
  {
    legalHoldId: text('legal_hold_id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    operatorId: text('operator_id').notNull(),
    placedAt: tsNow('placed_at'),
    releasedAt: ts('released_at'),
    releaseReason: text('release_reason'),
    releaseOperatorId: text('release_operator_id'),
    createdAt: tsNow('created_at'),
  },
  (t) => [
    index('idx_legal_holds_tenant').on(t.tenantId),
    check('chk_legal_holds_reason_nonempty', sql`length(btrim(${t.reason})) > 0`),
    check('chk_legal_holds_operator_nonempty', sql`length(btrim(${t.operatorId})) > 0`),
    check('chk_legal_holds_release_after_placement', sql`${t.releasedAt} IS NULL OR ${t.releasedAt} >= ${t.placedAt}`),
  ],
);

/**
 * What a retention sweep did, per tenant, per pass.
 *
 * A deletion that leaves no record is a deletion nobody can be asked about.
 * This table is that record: how many rows were purged, how many were
 * relinked, whether a legal hold stopped it, and the chain hashes at the
 * boundary so the record is tied to the chain it describes.
 */
export const retentionRuns = pgTable(
  'retention_runs',
  {
    retentionRunId: text('retention_run_id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at').notNull(),
    outcome: text('outcome').notNull().$type<'purged' | 'held' | 'skipped' | 'error'>(),
    auditRetentionDays: integer('audit_retention_days').notNull(),
    outboxRetentionDays: integer('outbox_retention_days').notNull(),
    auditCutoff: ts('audit_cutoff').notNull(),
    outboxCutoff: ts('outbox_cutoff').notNull(),
    auditRowsPurged: integer('audit_rows_purged').notNull().default(0),
    outboxRowsPurged: integer('outbox_rows_purged').notNull().default(0),
    auditRowsRelinked: integer('audit_rows_relinked').notNull().default(0),
    legalHold: boolean('legal_hold').notNull().default(false),
    chainHeadBefore: text('chain_head_before'),
    chainHeadAfter: text('chain_head_after'),
    chainBoundaryHash: text('chain_boundary_hash'),
    operatorId: text('operator_id').notNull(),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    createdAt: tsNow('created_at'),
  },
  (t) => [
    index('idx_retention_runs_tenant_started').on(t.tenantId, t.startedAt),
    check('chk_retention_runs_outcome', sql`${t.outcome} IN ('purged','held','skipped','error')`),
    check(
      'chk_retention_runs_counts_nonneg',
      sql`${t.auditRowsPurged} >= 0 AND ${t.outboxRowsPurged} >= 0 AND ${t.auditRowsRelinked} >= 0`,
    ),
  ],
);

export type LegalHoldRow = typeof legalHolds.$inferSelect;
export type RetentionRunRow = typeof retentionRuns.$inferSelect;

/** Every table this package owns, in dependency-safe insert order. */
export const ALL_TABLES = [
  tenants,
  users,
  tenantMemberships,
  mfaSecrets,
  serviceCredentials,
  agents,
  policies,
  policyRevisions,
  connectors,
  actions,
  approvals,
  permits,
  executions,
  auditEvents,
  outboxEvents,
  idempotencyRecords,
  modelEvaluations,
  replaySessions,
  replayResults,
  enforcementModes,
  vendors,
  invoices,
  purchaseOrders,
  connectorLedger,
  connectorDispatches,
  legalHolds,
  retentionRuns,
] as const;
