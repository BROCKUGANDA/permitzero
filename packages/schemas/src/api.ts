/**
 * HTTP API contract for /v1 (PRD §10, Master Prompt §8).
 *
 * Everything crossing the boundary is validated by these schemas. Note what is
 * deliberately *absent*: there is no `tenant_id` field on any request. Tenant is
 * resolved from the authenticated principal, never trusted from a body
 * (Master Prompt §5.1, FR-001).
 */
import { z } from 'zod';
import { Decision, ActionState, EnforcementMode, RiskSignalKind } from '@permitzero/domain';
import {
  actionHashSchema,
  actionIdSchema,
  agentIdSchema,
  amountMinorSchema,
  connectorIdSchema,
  currencySchema,
  environmentSchema,
  evidenceRefSchema,
  idSchema,
  idempotencyKeySchema,
  operatorTextSchema,
  pageSchema,
  paginationQuerySchema,
  policyIdSchema,
  policyRevisionIdSchema,
  runIdSchema,
  toolNameSchema,
  traceIdSchema,
} from './common.js';
import { policyDocumentSchema, PolicyLintSeverity } from './policy.js';

// ---------------------------------------------------------------------------
// Per-tool argument schemas. An unsupported tool is rejected at intake
// (FR-011) rather than accepted with unvalidated arguments.
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS = {
  'payment.execute': z
    .object({
      invoice_id: z.string().min(1).max(64),
      vendor_id: z.string().min(1).max(64),
      amount_minor: amountMinorSchema,
      currency: currencySchema,
      beneficiary_ref: z.string().min(1).max(128),
    })
    .strict(),
  'payment.propose': z
    .object({
      invoice_id: z.string().min(1).max(64),
      vendor_id: z.string().min(1).max(64),
      amount_minor: amountMinorSchema,
      currency: currencySchema,
      beneficiary_ref: z.string().min(1).max(128),
    })
    .strict(),
  'invoice.read': z.object({ invoice_id: z.string().min(1).max(64) }).strict(),
  'purchase_order.read': z
    .object({ purchase_order_id: z.string().min(1).max(64) })
    .strict(),
  'vendor.read': z.object({ vendor_id: z.string().min(1).max(64) }).strict(),
  'vendor.update_bank_details': z
    .object({
      vendor_id: z.string().min(1).max(64),
      new_beneficiary_ref: z.string().min(1).max(128),
      reason: z.string().min(1).max(500),
      verification_ref: z.string().max(128).nullable(),
    })
    .strict(),
  'vendor.export': z
    .object({
      vendor_id: z.string().min(1).max(64).nullable(),
      record_limit: z.number().int().min(1).max(100000),
      data_classification: z.string().min(1).max(64),
    })
    .strict(),
} as const;

export type SupportedTool = keyof typeof TOOL_SCHEMAS;
export const SUPPORTED_TOOLS = Object.keys(TOOL_SCHEMAS) as SupportedTool[];

/** Tools that mutate external state and therefore require a broker permit. */
export const SIDE_EFFECTING_TOOLS: readonly SupportedTool[] = [
  'payment.execute',
  'vendor.update_bank_details',
  'vendor.export',
];

export function isSideEffectingTool(tool: string): boolean {
  return (SIDE_EFFECTING_TOOLS as readonly string[]).includes(tool);
}

export const toolArgumentsSchema = z.discriminatedUnion('tool_name', [
  z.object({ tool_name: z.literal('payment.execute'), arguments: TOOL_SCHEMAS['payment.execute'] }),
  z.object({ tool_name: z.literal('payment.propose'), arguments: TOOL_SCHEMAS['payment.propose'] }),
  z.object({ tool_name: z.literal('invoice.read'), arguments: TOOL_SCHEMAS['invoice.read'] }),
  z.object({
    tool_name: z.literal('purchase_order.read'),
    arguments: TOOL_SCHEMAS['purchase_order.read'],
  }),
  z.object({ tool_name: z.literal('vendor.read'), arguments: TOOL_SCHEMAS['vendor.read'] }),
  z.object({
    tool_name: z.literal('vendor.update_bank_details'),
    arguments: TOOL_SCHEMAS['vendor.update_bank_details'],
  }),
  z.object({ tool_name: z.literal('vendor.export'), arguments: TOOL_SCHEMAS['vendor.export'] }),
]);

// ---------------------------------------------------------------------------
// POST /v1/actions
// ---------------------------------------------------------------------------

export const createActionRequestSchema = z
  .object({
    agent_id: agentIdSchema,
    run_id: runIdSchema,
    task_purpose: z.string().min(1).max(500),
    tool_name: toolNameSchema,
    /** Validated against the per-tool schema above once tool_name is known. */
    arguments: z.record(z.unknown()),
    evidence_refs: z.array(evidenceRefSchema).max(32).default([]),
    idempotency_key: idempotencyKeySchema,
    environment: environmentSchema,
    requested_at: z.coerce.date().optional(),
  })
  .strict();
export type CreateActionRequest = z.infer<typeof createActionRequestSchema>;

export const riskSignalSchema = z
  .object({
    kind: z.nativeEnum(RiskSignalKind),
    source: z.enum(['DETERMINISTIC', 'MODEL_ADVISORY']),
    severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    reason_code: z.string(),
    evidence_ref: z.string().nullable(),
    confidence: z.number().nullable(),
    detail: z.string(),
  })
  .strict();

export const permitDtoSchema = z
  .object({
    permit_id: idSchema('permit'),
    /** Opaque, single-use, short-lived. Returned exactly once, never logged. */
    token: z.string(),
    audience: toolNameSchema,
    action_hash: actionHashSchema,
    policy_revision_id: policyRevisionIdSchema,
    issued_at: z.date(),
    expires_at: z.date(),
  })
  .strict();
export type PermitDto = z.infer<typeof permitDtoSchema>;

export const evaluatedRuleDtoSchema = z
  .object({
    rule_id: z.string(),
    effect: z.enum(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']),
    matched: z.boolean(),
    reason_code: z.string(),
    detail: z.string(),
  })
  .strict();

export const decisionDtoSchema = z
  .object({
    decision: z.nativeEnum(Decision),
    reason_codes: z.array(z.string()),
    rules_evaluated: z.array(evaluatedRuleDtoSchema),
    required_approvals: z.number().int(),
    policy_revision_id: policyRevisionIdSchema.nullable(),
    policy_revision_number: z.number().int().nullable(),
    policy_hash: z.string().nullable(),
  })
  .strict();

export const approvalProgressSchema = z
  .object({
    required_approvals: z.number().int(),
    approvals_received: z.number().int(),
    distinct_approvers: z.number().int(),
    requires_independent_verification: z.boolean(),
    independent_verification_present: z.boolean(),
    requires_mfa: z.boolean(),
    expires_at: z.date().nullable(),
    invalidated: z.boolean(),
    invalidation_reason: z.string().nullable(),
  })
  .strict();
export type ApprovalProgress = z.infer<typeof approvalProgressSchema>;

export const actionDtoSchema = z
  .object({
    action_id: actionIdSchema,
    tenant_id: idSchema('tenant'),
    agent_id: agentIdSchema,
    run_id: runIdSchema,
    tool_name: z.string(),
    operation: z.string(),
    task_purpose: z.string(),
    arguments_redacted: z.record(z.unknown()),
    action_hash: actionHashSchema,
    hash_version: z.string(),
    evidence_refs: z.array(z.string()),
    idempotency_key: z.string(),
    state: z.nativeEnum(ActionState),
    decision: z.nativeEnum(Decision).nullable(),
    reason_codes: z.array(z.string()),
    risk_signals: z.array(riskSignalSchema),
    policy_revision_id: policyRevisionIdSchema.nullable(),
    policy_revision_number: z.number().int().nullable(),
    required_approvals: z.number().int(),
    approval_progress: approvalProgressSchema.nullable(),
    permit: permitDtoSchema.omit({ token: true }).nullable(),
    execution: z
      .object({
        execution_id: idSchema('execution'),
        state: z.string(),
        attempt_number: z.number().int(),
        connector_id: connectorIdSchema.nullable(),
        external_reference: z.string().nullable(),
        receipt_hash: z.string().nullable(),
        error_class: z.string().nullable(),
        dispatch_started_at: z.date().nullable(),
        result_received_at: z.date().nullable(),
      })
      .strict()
      .nullable(),
    trace_id: traceIdSchema,
    environment: environmentSchema,
    requested_at: z.date(),
    expires_at: z.date().nullable(),
    version: z.number().int(),
    created_at: z.date(),
    updated_at: z.date(),
  })
  .strict();
export type ActionDto = z.infer<typeof actionDtoSchema>;

export const createActionResponseSchema = z
  .object({
    action_id: actionIdSchema,
    state: z.nativeEnum(ActionState),
    decision: z.nativeEnum(Decision),
    policy_revision: z
      .object({
        id: policyRevisionIdSchema,
        revision_number: z.number().int(),
        policy_hash: z.string(),
      })
      .nullable(),
    reason_codes: z.array(z.string()),
    action_hash: actionHashSchema,
    hash_version: z.string(),
    permit: permitDtoSchema.nullable(),
    approval: approvalProgressSchema.nullable(),
    risk_signals: z.array(riskSignalSchema),
    trace_id: traceIdSchema,
    requested_at: z.date(),
    expires_at: z.date().nullable(),
    /** True when the request replayed an existing idempotency key. */
    replayed: z.boolean(),
    enforcement_mode: z.nativeEnum(EnforcementMode),
  })
  .strict();
export type CreateActionResponse = z.infer<typeof createActionResponseSchema>;

// ---------------------------------------------------------------------------
// Approve / reject
// ---------------------------------------------------------------------------

export const approvalReasonCodeSchema = z.enum([
  'EVIDENCE_REVIEWED',
  'VENDOR_VERIFIED_OUT_OF_BAND',
  'PO_CONFIRMED',
  'EXCEPTION_GRANTED',
  'RISK_ACCEPTED_WITH_CONDITIONS',
  'DUPLICATE_SUSPECTED',
  'BENEFICIARY_UNVERIFIED',
  'AMOUNT_UNJUSTIFIED',
  'POLICY_MISCONFIGURED',
  'INSUFFICIENT_EVIDENCE',
  'REQUESTER_NOT_AUTHORISED',
  'OTHER',
]);

export const approveActionRequestSchema = z
  .object({
    decision: z.literal('APPROVE'),
    reason_code: approvalReasonCodeSchema,
    reason_text: operatorTextSchema.optional(),
    idempotency_key: idempotencyKeySchema,
    /** The hash the approver actually reviewed. The server compares it against
     * the current action hash and rejects on mismatch (FR-041). */
    action_hash: actionHashSchema,
    policy_revision_id: policyRevisionIdSchema,
    /** Present when step-up authentication was completed for this decision. */
    mfa_context_ref: z.string().max(128).optional(),
  })
  .strict();
export type ApproveActionRequest = z.infer<typeof approveActionRequestSchema>;

export const rejectActionRequestSchema = z
  .object({
    decision: z.literal('REJECT'),
    reason_code: approvalReasonCodeSchema,
    reason_text: operatorTextSchema.optional(),
    idempotency_key: idempotencyKeySchema,
  })
  .strict();
export type RejectActionRequest = z.infer<typeof rejectActionRequestSchema>;

// ---------------------------------------------------------------------------
// Execute (broker-only)
// ---------------------------------------------------------------------------

export const executeActionRequestSchema = z
  .object({
    permit_token: z.string().min(16).max(512),
    idempotency_key: idempotencyKeySchema,
    /** Caller-supplied client timeout in ms. The broker records an unknown
     * outcome rather than assuming failure when this elapses after dispatch. */
    client_timeout_ms: z.number().int().min(100).max(120000).optional(),
  })
  .strict();
export type ExecuteActionRequest = z.infer<typeof executeActionRequestSchema>;

export const executeActionResponseSchema = z
  .object({
    action_id: actionIdSchema,
    execution_id: idSchema('execution'),
    state: z.nativeEnum(ActionState),
    /** 202 semantics: accepted, not confirmed. Never "succeeded" without a
     * verified connector receipt (PRD §10.5). */
    accepted: z.boolean(),
    receipt: z
      .object({
        external_reference: z.string(),
        receipt_hash: z.string(),
        amount_minor: z.number().int(),
        currency: z.string(),
        beneficiary_ref: z.string(),
        completed_at: z.date(),
        simulated: z.literal(true),
      })
      .strict()
      .nullable(),
    trace_id: traceIdSchema,
  })
  .strict();
export type ExecuteActionResponse = z.infer<typeof executeActionResponseSchema>;

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export const createPolicyRequestSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(1000).default(''),
    document: policyDocumentSchema,
    change_reason: operatorTextSchema,
  })
  .strict();

export const policyRevisionDtoSchema = z
  .object({
    id: policyRevisionIdSchema,
    policy_id: policyIdSchema,
    revision_number: z.number().int(),
    status: z.enum(['DRAFT', 'SIMULATING', 'READY', 'PUBLISHED', 'ROLLED_BACK']),
    policy_hash: z.string(),
    created_by: z.string(),
    change_reason: z.string(),
    created_at: z.date(),
    published_at: z.date().nullable(),
    document: policyDocumentSchema.optional(),
  })
  .strict();
export type PolicyRevisionDto = z.infer<typeof policyRevisionDtoSchema>;

export const publishPolicyRequestSchema = z
  .object({
    revision_id: policyRevisionIdSchema,
    /** Optimistic concurrency: the revision the client believes is published
     * now. A mismatch returns 409 STALE_REVISION (PRD §10.7). */
    expected_current_revision_id: policyRevisionIdSchema.nullable(),
    change_reason: operatorTextSchema,
    /** Required when a replay showed a previously-forbidden action becoming
     * allowed (FR-062: explicit sign-off). */
    high_risk_sign_off: z.boolean().optional(),
  })
  .strict();
export type PublishPolicyRequest = z.infer<typeof publishPolicyRequestSchema>;

export const simulatePolicyRequestSchema = z
  .object({
    revision_id: policyRevisionIdSchema,
    /** Either explicit actions or a versioned fixture corpus — never both. */
    action_ids: z.array(actionIdSchema).max(500).optional(),
    corpus_id: z.string().max(128).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.action_ids) !== Boolean(v.corpus_id), {
    message: 'provide exactly one of action_ids or corpus_id',
  });
export type SimulatePolicyRequest = z.infer<typeof simulatePolicyRequestSchema>;

export const lintPolicyResponseSchema = z.object({
  findings: z.array(
    z
      .object({
        code: z.string(),
        severity: z.nativeEnum(PolicyLintSeverity),
        rule_ids: z.array(z.string()),
        message: z.string(),
      })
      .strict(),
  ),
  publishable: z.boolean(),
});

// ---------------------------------------------------------------------------
// Audit / evidence
// ---------------------------------------------------------------------------

export const auditEventDtoSchema = z
  .object({
    event_id: idSchema('auditEvent'),
    tenant_id: idSchema('tenant'),
    action_id: actionIdSchema.nullable(),
    run_id: z.string().nullable(),
    actor_type: z.enum(['USER', 'AGENT', 'SYSTEM', 'WORKER']),
    actor_id: z.string(),
    event_type: z.string(),
    event_time: z.date(),
    trace_id: z.string().nullable(),
    policy_revision_id: z.string().nullable(),
    payload_redacted: z.record(z.unknown()),
    previous_hash: z.string().nullable(),
    event_hash: z.string(),
    hash_version: z.string(),
    sequence: z.number().int(),
  })
  .strict();
export type AuditEventDto = z.infer<typeof auditEventDtoSchema>;

export const auditQuerySchema = paginationQuerySchema.extend({
  action_id: actionIdSchema.optional(),
  run_id: z.string().max(128).optional(),
  agent_id: agentIdSchema.optional(),
  event_type: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const auditBundleSchema = z
  .object({
    manifest: z
      .object({
        tenant_id: idSchema('tenant'),
        generated_at: z.date(),
        event_count: z.number().int(),
        first_sequence: z.number().int(),
        last_sequence: z.number().int(),
        hash_version: z.string(),
        head_event_hash: z.string(),
        corpus_version: z.string().nullable(),
      })
      .strict(),
    events: z.array(auditEventDtoSchema),
    policy_snapshots: z.array(policyRevisionDtoSchema),
    verification: z
      .object({
        chain_valid: z.boolean(),
        /** Honest reporting of gaps rather than a claim of tamper-proofing
         * (FR-053). */
        gaps: z.array(z.object({ after_sequence: z.number().int(), detail: z.string() }).strict()),
        missing_receipts: z.array(actionIdSchema),
      })
      .strict(),
  })
  .strict();
export type AuditBundle = z.infer<typeof auditBundleSchema>;

export const auditPageSchema = pageSchema(auditEventDtoSchema);

// ---------------------------------------------------------------------------
// Health / status / modes
// ---------------------------------------------------------------------------

export const healthLiveSchema = z.object({ status: z.literal('ok') }).strict();

export const healthReadySchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    database: z.boolean(),
    migrations_applied: z.boolean(),
    /** Alive but not ready for protected writes is a real, distinct state
     * (PRD §10.8). */
    protected_writes_allowed: z.boolean(),
    reasons: z.array(z.string()),
  })
  .strict();

export const statusSchema = z
  .object({
    status: z.enum(['ok', 'degraded', 'unavailable']),
    enforcement_mode: z.nativeEnum(EnforcementMode),
    synthetic_data_mode: z.boolean(),
    app_env: z.string(),
    version: z.string(),
    dependencies: z
      .object({
        database: z.enum(['up', 'down']),
        redis: z.enum(['up', 'down', 'disabled']),
        queue: z.object({
          status: z.enum(['ok', 'degraded', 'down', 'disabled']),
          depth: z.number().int(),
          oldest_job_age_ms: z.number().int().nullable(),
          outbox_pending: z.number().int(),
          outbox_dead: z.number().int(),
        }),
        model_provider: z.object({
          enabled: z.boolean(),
          status: z.enum(['ok', 'degraded', 'down', 'disabled']),
          breaker: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
          model_id: z.string().nullable(),
        }),
      })
      .strict(),
    connectors: z.object({
      total: z.number().int(),
      healthy: z.number().int(),
      degraded: z.number().int(),
      quarantined: z.number().int(),
    }),
    checked_at: z.date(),
  })
  .strict();
export type StatusResponse = z.infer<typeof statusSchema>;

export const changeModeRequestSchema = z
  .object({
    mode: z.nativeEnum(EnforcementMode),
    reason: operatorTextSchema,
    scope: z
      .object({
        agent_id: agentIdSchema.optional(),
        connector_id: connectorIdSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Replay Lab
// ---------------------------------------------------------------------------

export const createReplayRequestSchema = z
  .object({
    policy_id: policyIdSchema,
    baseline_revision_id: policyRevisionIdSchema,
    candidate_revision_id: policyRevisionIdSchema,
    corpus_id: z.string().min(1).max(128),
  })
  .strict();

export const replayResultRowSchema = z
  .object({
    fixture_id: z.string(),
    label: z.string(),
    expected_decision: z.nativeEnum(Decision),
    baseline_decision: z.nativeEnum(Decision),
    candidate_decision: z.nativeEnum(Decision),
    changed: z.boolean(),
    baseline_reason_codes: z.array(z.string()),
    candidate_reason_codes: z.array(z.string()),
    added_reason_codes: z.array(z.string()),
    removed_reason_codes: z.array(z.string()),
    severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    /** The single most important flag in the Replay Lab: a forbidden action that
     * the candidate would newly allow. */
    newly_allows_forbidden: z.boolean(),
  })
  .strict();

export const replaySessionSchema = z
  .object({
    replay_id: idSchema('replay'),
    policy_id: policyIdSchema,
    baseline_revision_id: policyRevisionIdSchema,
    candidate_revision_id: policyRevisionIdSchema,
    baseline_policy_hash: z.string(),
    candidate_policy_hash: z.string(),
    corpus_id: z.string(),
    corpus_version: z.string(),
    status: z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']),
    created_at: z.date(),
    completed_at: z.date().nullable(),
    total: z.number().int(),
    confusion: z
      .object({
        allowed_by_both: z.number().int(),
        denied_by_both: z.number().int(),
        baseline_allow_candidate_deny: z.number().int(),
        baseline_deny_candidate_allow: z.number().int(),
        approval_changes: z.number().int(),
      })
      .strict(),
    false_allow_count: z.number().int(),
    false_deny_count: z.number().int(),
    changed_count: z.number().int(),
    /** Replay is sandbox-only; asserting this in the response keeps the guarantee
     * visible rather than implied (PRD §7.3.E). */
    connector_calls: z.literal(0),
    results: z.array(replayResultRowSchema).optional(),
  })
  .strict();
export type ReplaySession = z.infer<typeof replaySessionSchema>;

export { pageSchema, paginationQuerySchema };
