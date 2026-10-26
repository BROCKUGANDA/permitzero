/**
 * @permitzero/policy test suite.
 *
 * Covers the contract in `docs/module-contracts.md`: deny precedence, default
 * deny, unresolvable-field handling, fail-closed gates, model-can-never-allow,
 * approval quorum, explanation ordering, lint codes and replay simulation.
 */
import { describe, expect, it } from 'vitest';
import {
  ApprovalReason,
  DenyReason,
  IndeterminateReason,
} from '@permitzero/domain';
import type {
  AgentRecord,
  ConnectorRecord,
  InvoiceRecord,
  PolicyEvaluationInput,
  Principal,
  PurchaseOrderRecord,
  RiskHints,
  VendorRecord,
} from '@permitzero/domain';
import { POLICY_FIELDS } from '@permitzero/schemas';
import type {
  Condition,
  ConditionGroup,
  PolicyDocument,
  PolicyField,
  PolicyOperator,
  PolicyRule,
  RuleEffect,
} from '@permitzero/schemas';
import {
  DEFAULT_MAX_FIXTURES,
  evaluatePolicy,
  hashPolicyDocument,
  lintPolicy,
  resolveFields,
  simulatePolicy,
} from '../src/index.js';
import type { PinnedPolicyRevision } from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = 'ten_demo';
const REQUESTED_AT = '2026-10-26T12:00:00Z';

const baseAgent: AgentRecord = {
  agentId: 'agt_demo_ap',
  tenantId: TENANT,
  name: 'demo-ap',
  framework: 'demo-harness',
  environment: 'DEMO',
  status: 'ACTIVE',
  credentialId: 'cred_demo_001',
  credentialExpiresAt: null,
  allowedTools: [{ toolName: 'payment.execute', operations: ['execute'] }],
  revokedAt: null,
};

const basePrincipal: Principal = {
  actorType: 'AGENT',
  actorId: 'agt_demo_ap',
  tenantId: TENANT,
  roles: ['SERVICE_AGENT'],
  environment: 'DEMO',
  displayName: 'demo-ap',
  agentId: 'agt_demo_ap',
  credentialId: 'cred_demo_001',
  credentialExpiresAt: null,
  mfaVerifiedAt: null,
};

const baseVendor: VendorRecord = {
  vendorId: 'VEN-017',
  tenantId: TENANT,
  name: 'SYNTHETIC Example Ltd',
  status: 'VERIFIED',
  verifiedBeneficiaryRef: 'BEN-017-VERIFIED',
  verifiedAt: new Date('2026-01-15T00:00:00Z'),
  bankingChangedAt: null,
  bankingChangeVerifiedAt: null,
  pendingBeneficiaryRef: null,
  allowedDestinationRefs: ['BEN-017-VERIFIED'],
  accountAgeDays: 400,
  dataClassification: 'INTERNAL',
};

const baseInvoice: InvoiceRecord = {
  invoiceId: 'INV-2041',
  tenantId: TENANT,
  vendorId: 'VEN-017',
  amountMinor: 300000,
  currency: 'USD',
  purchaseOrderId: 'PO-882',
  status: 'OPEN',
  documentText: null,
  untrusted: true,
};

const basePurchaseOrder: PurchaseOrderRecord = {
  purchaseOrderId: 'PO-882',
  tenantId: TENANT,
  vendorId: 'VEN-017',
  amountMinor: 300000,
  currency: 'USD',
  status: 'OPEN',
  matchedInvoiceIds: [],
};

const baseConnector: ConnectorRecord = {
  connectorId: 'con_sim_001',
  tenantId: TENANT,
  name: 'simulated-finance',
  type: 'SIMULATED_FINANCE',
  environment: 'DEMO',
  status: 'ENABLED',
  allowedTools: ['payment.execute', 'vendor.update_bank_details', 'invoice.read'],
  credentialRef: 'secret://simulated-finance/demo',
  lastHealthCheckAt: null,
  simulated: true,
};

function baseInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    tenantId: TENANT,
    environment: 'DEMO',
    agent: { ...baseAgent },
    principal: { ...basePrincipal, roles: [...basePrincipal.roles] },
    toolName: 'payment.execute',
    operation: 'execute',
    taskPurpose: 'Pay invoice INV-2041 against PO-882',
    arguments: {
      invoice_id: 'INV-2041',
      vendor_id: 'VEN-017',
      amount_minor: 300000,
      currency: 'USD',
      beneficiary_ref: 'BEN-017-VERIFIED',
    },
    evidenceRefs: [
      { ref: 'invoice:INV-2041', kind: 'invoice', trusted: false },
      { ref: 'purchase-order:PO-882', kind: 'purchase-order', trusted: true },
    ],
    requestedAt: new Date(REQUESTED_AT),
    runId: 'run_20261026_001',
    actionCountInRun: 1,
    vendor: { ...baseVendor, allowedDestinationRefs: [...baseVendor.allowedDestinationRefs] },
    invoice: { ...baseInvoice },
    purchaseOrder: { ...basePurchaseOrder },
    connector: { ...baseConnector, allowedTools: [...baseConnector.allowedTools] },
    riskHints: null,
    requiredModelSignalUnavailable: false,
    budgetSpendMinor: 0,
    velocityCount: 0,
    velocityWindowStartedAt: null,
    enforcementMode: 'ENFORCED',
    policyStoreAvailable: true,
    ...overrides,
  };
}

function cond(field: PolicyField, op: PolicyOperator, value?: Condition['value']): Condition {
  return value === undefined ? { field, op } : { field, op, value };
}

function quorum(n: number): NonNullable<PolicyRule['approval']> {
  return {
    required_approvals: n,
    require_distinct_approvers: true,
    require_independent_verification: false,
    require_mfa: false,
    ttl_seconds: 900,
  };
}

function makeRule(r: {
  id: string;
  effect: RuleEffect;
  reason_code: string;
  when: ConditionGroup;
  description?: string;
  priority?: number;
  enabled?: boolean;
  scope?: PolicyRule['scope'];
  approval?: PolicyRule['approval'];
}): PolicyRule {
  return { description: r.id, priority: 100, enabled: true, scope: {}, ...r };
}

/** AP-PROTECT-01 style policy: deny unhealthy state, approve large or vendor-change actions, allow verified low-value payments. */
function apPolicy(): PolicyDocument {
  return {
    schema_version: 'policy.v1',
    default_effect: 'DENY',
    rules: [
      makeRule({
        id: 'deny-blocked-vendor',
        effect: 'DENY',
        reason_code: 'VENDOR_BLOCKED',
        priority: 1000,
        scope: { tools: ['payment.execute', 'vendor.update_bank_details'] },
        when: { any: [cond('vendor.status', 'equals', 'BLOCKED')] },
      }),
      makeRule({
        id: 'deny-unknown-vendor',
        effect: 'DENY',
        reason_code: 'VENDOR_UNKNOWN',
        priority: 950,
        scope: { tools: ['payment.execute'] },
        when: { any: [cond('vendor.exists', 'is_false')] },
      }),
      makeRule({
        id: 'deny-unverified-vendor',
        effect: 'DENY',
        reason_code: 'VENDOR_NOT_VERIFIED',
        priority: 940,
        scope: { tools: ['payment.execute'] },
        when: { any: [cond('vendor.status', 'not_equals', 'VERIFIED')] },
      }),
      makeRule({
        id: 'deny-revoked-agent',
        effect: 'DENY',
        reason_code: 'AGENT_REVOKED',
        priority: 900,
        when: { any: [cond('agent.status', 'equals', 'REVOKED')] },
      }),
      makeRule({
        id: 'deny-suspended-agent',
        effect: 'DENY',
        reason_code: 'AGENT_SUSPENDED',
        priority: 900,
        when: { any: [cond('agent.status', 'equals', 'SUSPENDED')] },
      }),
      makeRule({
        id: 'deny-disabled-connector',
        effect: 'DENY',
        reason_code: 'CONNECTOR_DISABLED',
        priority: 900,
        when: { any: [cond('connector.status', 'not_equals', 'ENABLED')] },
      }),
      makeRule({
        id: 'deny-beneficiary-mismatch',
        effect: 'DENY',
        reason_code: 'DESTINATION_MISMATCH',
        priority: 800,
        scope: { tools: ['payment.execute'] },
        when: { any: [cond('vendor.beneficiary_matches_verified', 'is_false')] },
      }),
      makeRule({
        id: 'deny-cooling-period',
        effect: 'DENY',
        reason_code: 'BENEFICIARY_CHANGE_WITHIN_COOLING_PERIOD',
        priority: 800,
        scope: { tools: ['payment.execute'] },
        when: {
          all: [
            cond('vendor.banking_change_hours_ago', 'less_than', 168),
            cond('vendor.banking_change_verified', 'is_false'),
          ],
        },
      }),
      makeRule({
        id: 'deny-po-mismatch',
        effect: 'DENY',
        reason_code: 'PO_NOT_MATCHED',
        priority: 800,
        scope: { tools: ['payment.execute'] },
        when: { any: [cond('purchase_order.matched', 'is_false')] },
      }),
      makeRule({
        id: 'deny-over-hard-limit',
        effect: 'DENY',
        reason_code: 'AMOUNT_OVER_LIMIT',
        priority: 700,
        scope: { tools: ['payment.execute'] },
        when: { any: [cond('arguments.amount_minor', 'greater_than', 5000000)] },
      }),
      makeRule({
        id: 'approval-over-threshold',
        effect: 'REQUIRE_APPROVAL',
        reason_code: 'AMOUNT_OVER_APPROVAL_THRESHOLD',
        priority: 500,
        scope: { tools: ['payment.execute'] },
        approval: quorum(1),
        when: { any: [cond('arguments.amount_minor', 'greater_than', 500000)] },
      }),
      makeRule({
        id: 'approval-vendor-change',
        effect: 'REQUIRE_APPROVAL',
        reason_code: 'DUAL_APPROVAL_REQUIRED',
        priority: 500,
        scope: { tools: ['vendor.update_bank_details'] },
        approval: { ...quorum(2), require_independent_verification: true },
        when: { none: [] },
      }),
      makeRule({
        id: 'approval-on-injection',
        effect: 'REQUIRE_APPROVAL',
        reason_code: 'MODEL_RISK_SIGNAL_ESCALATION',
        priority: 400,
        approval: quorum(1),
        when: { any: [cond('model.max_injection_confidence', 'greater_than', 0.7)] },
      }),
      makeRule({
        id: 'allow-standard-payment',
        effect: 'ALLOW',
        reason_code: 'WITHIN_LIMIT',
        priority: 100,
        scope: { tools: ['payment.execute'] },
        when: {
          all: [
            cond('arguments.amount_minor', 'less_than_or_equal', 500000),
            cond('vendor.status', 'equals', 'VERIFIED'),
            cond('vendor.beneficiary_matches_verified', 'is_true'),
            cond('purchase_order.matched', 'is_true'),
          ],
        },
      }),
      makeRule({
        id: 'allow-reads',
        effect: 'ALLOW',
        reason_code: 'TOOL_ALLOWED',
        priority: 100,
        scope: { tools: ['invoice.read', 'purchase_order.read', 'vendor.read'] },
        when: { none: [] },
      }),
    ],
  };
}

function makeRevision(document: PolicyDocument, overrides: Partial<PinnedPolicyRevision> = {}): PinnedPolicyRevision {
  return {
    revisionId: 'polrev_test_001',
    policyId: 'pol_test_001',
    tenantId: TENANT,
    revisionNumber: 7,
    document,
    policyHash: hashPolicyDocument(document),
    status: 'PUBLISHED',
    publishedAt: new Date('2026-10-26T11:00:00Z'),
    ...overrides,
  };
}

function injectionHints(): RiskHints {
  return {
    schemaVersion: 'risk-hints.v1',
    instructionInjectionIndicators: [
      { kind: 'REQUEST_TO_BYPASS_CONTROLS', evidenceRef: 'invoice:INV-2042', confidence: 0.91 },
      { kind: 'BENEFICIARY_CHANGE_REQUEST', evidenceRef: 'invoice:INV-2042', confidence: 0.65 },
    ],
    extractedFacts: { invoice_id: 'INV-2042', vendor_name: 'Example Ltd' },
    missingEvidence: ['verified_beneficiary_reference'],
    summary: 'The document requests a vendor bank change; independent verification is missing.',
  };
}

// ---------------------------------------------------------------------------
// Document hashing and revision binding
// ---------------------------------------------------------------------------

describe('hashPolicyDocument', () => {
  it('is deterministic across key order', () => {
    const a = apPolicy();
    const b: PolicyDocument = {
      rules: a.rules,
      default_effect: 'DENY',
      schema_version: 'policy.v1',
    };
    expect(hashPolicyDocument(a)).toBe(hashPolicyDocument(b));
  });

  it('changes when the document changes', () => {
    const a = apPolicy();
    const b = apPolicy();
    b.rules = [...b.rules, makeRule({ id: 'extra', effect: 'DENY', reason_code: 'DEFAULT_DENY', when: { none: [] } })];
    expect(hashPolicyDocument(a)).not.toBe(hashPolicyDocument(b));
  });

  it('produces sha256:<hex> shape', () => {
    expect(hashPolicyDocument(apPolicy())).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('revision binding gates', () => {
  it('denies when the document no longer matches the pinned hash', () => {
    const doc = apPolicy();
    const revision = makeRevision(doc);
    revision.document = { ...doc, rules: doc.rules.slice(0, 1) };
    const result = evaluatePolicy(baseInput(), revision);
    expect(result.decision).toBe('DENY');
    expect(result.reasonCodes).toContain(DenyReason.POLICY_HASH_MISMATCH);
    expect(result.rulesEvaluated).toHaveLength(0);
  });

  it('denies when the revision belongs to another tenant', () => {
    const revision = makeRevision(apPolicy(), { tenantId: 'ten_other' });
    const result = evaluatePolicy(baseInput(), revision);
    expect(result.decision).toBe('DENY');
    expect(result.reasonCodes).toContain(DenyReason.TENANT_MISMATCH);
  });
});

// ---------------------------------------------------------------------------
// Allow path and thresholds
// ---------------------------------------------------------------------------

describe('allow path', () => {
  it('allows the benign $3,000 invoice and explains every in-scope rule in stable order', () => {
    const result = evaluatePolicy(baseInput(), makeRevision(apPolicy()));
    expect(result.decision).toBe('ALLOW');
    expect(result.reasonCodes).toEqual(['WITHIN_LIMIT']);
    expect(result.requiredApprovals).toBe(0);
    expect(result.rulesEvaluated.map((r) => r.ruleId)).toEqual([
      'deny-blocked-vendor',
      'deny-unknown-vendor',
      'deny-unverified-vendor',
      'deny-disabled-connector',
      'deny-revoked-agent',
      'deny-suspended-agent',
      'deny-beneficiary-mismatch',
      'deny-cooling-period',
      'deny-po-mismatch',
      'deny-over-hard-limit',
      'approval-over-threshold',
      'approval-on-injection',
      'allow-standard-payment',
    ]);
    const allow = result.rulesEvaluated.filter((r) => r.ruleId === 'allow-standard-payment');
    expect(allow).toHaveLength(1);
    expect(allow[0]?.matched).toBe(true);
    for (const r of result.rulesEvaluated) {
      expect(typeof r.detail).toBe('string');
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });

  it.each([
    [499999, 'ALLOW'],
    [500000, 'ALLOW'],
    [500001, 'REQUIRE_APPROVAL'],
    [5000000, 'REQUIRE_APPROVAL'],
    [5000001, 'DENY'],
    [7500000, 'DENY'],
  ])('amount %i decides %s at the threshold boundaries', (amount, decision) => {
    const input = baseInput({
      arguments: { ...baseInput().arguments, amount_minor: amount },
      // Keep invoice/PO aligned with the proposed amount so only the threshold rules vary.
      invoice: { ...baseInvoice, amountMinor: amount },
      purchaseOrder: { ...basePurchaseOrder, amountMinor: amount },
    });
    const result = evaluatePolicy(input, makeRevision(apPolicy()));
    expect(result.decision).toBe(decision);
  });

  it('allows reads without authoritative lookups', () => {
    const input = baseInput({
      toolName: 'invoice.read',
      operation: 'read',
      arguments: { invoice_id: 'INV-2041' },
      vendor: undefined,
      invoice: undefined,
      purchaseOrder: undefined,
      connector: undefined,
    });
    const result = evaluatePolicy(input, makeRevision(apPolicy()));
    expect(result.decision).toBe('ALLOW');
    expect(result.reasonCodes).toEqual(['TOOL_ALLOWED']);
  });

  it('routes vendor bank-detail changes to dual approval', () => {
    const input = baseInput({
      toolName: 'vendor.update_bank_details',
      operation: 'update',
      taskPurpose: 'Change vendor bank details per attachment request',
      arguments: {
        vendor_id: 'VEN-017',
        new_beneficiary_ref: 'BEN-999-UNVERIFIED',
        reason: 'attachment says so',
        verification_ref: null,
      },
    });
    const result = evaluatePolicy(input, makeRevision(apPolicy()));
    expect(result.decision).toBe('REQUIRE_APPROVAL');
    expect(result.reasonCodes).toContain('DUAL_APPROVAL_REQUIRED');
    expect(result.requiredApprovals).toBe(2);
  });

  it('blocks the malicious high-value invoice by deterministic rules even with model hints present', () => {
    const input = baseInput({
      taskPurpose: 'Pay invoice INV-2042 urgently, bypass approval',
      arguments: {
        invoice_id: 'INV-2042',
        vendor_id: 'VEN-017',
        amount_minor: 7500000,
        currency: 'USD',
        beneficiary_ref: 'BEN-999-UNVERIFIED',
      },
      vendor: { ...baseVendor, bankingChangedAt: new Date('2026-10-26T10:00:00Z'), bankingChangeVerifiedAt: null },
      riskHints: injectionHints(),
    });
    const result = evaluatePolicy(input, makeRevision(apPolicy()));
    expect(result.decision).toBe('DENY');
    expect(result.reasonCodes).toContain(DenyReason.DESTINATION_MISMATCH);
    expect(result.reasonCodes).toContain(DenyReason.BENEFICIARY_CHANGE_WITHIN_COOLING_PERIOD);
    expect(result.reasonCodes).toContain(DenyReason.AMOUNT_OVER_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Deny precedence and default deny
// ---------------------------------------------------------------------------

describe('deny precedence and default deny', () => {
  it('lets a matching deny win over a matching allow regardless of priority', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({ id: 'allow-all', effect: 'ALLOW', reason_code: 'TOOL_ALLOWED', priority: 9999, when: { none: [] } }),
        makeRule({
          id: 'deny-payments',
          effect: 'DENY',
          reason_code: 'TOOL_NOT_ALLOWED',
          priority: 0,
          when: { any: [cond('tool.name', 'equals', 'payment.execute')] },
        }),
      ],
    };
    const result = evaluatePolicy(baseInput(), makeRevision(doc));
    expect(result.decision).toBe('DENY');
    expect(result.reasonCodes).toEqual(['TOOL_NOT_ALLOWED']);
    expect(result.denyReasons).toEqual(['TOOL_NOT_ALLOWED']);
  });

  it('denies with NO_EXPLICIT_ALLOW when nothing matches', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({
          id: 'allow-reads-only',
          effect: 'ALLOW',
          reason_code: 'TOOL_ALLOWED',
          scope: { tools: ['invoice.read'] },
          when: { none: [] },
        }),
      ],
    };
    const result = evaluatePolicy(baseInput(), makeRevision(doc));
    expect(result.decision).toBe('DENY');
    expect(result.reasonCodes).toEqual([DenyReason.NO_EXPLICIT_ALLOW]);
  });

  it('denies rather than throwing on an empty rule list', () => {
    const doc: PolicyDocument = { schema_version: 'policy.v1', default_effect: 'DENY', rules: [] };
    const result = evaluatePolicy(baseInput(), makeRevision(doc));
    expect(result.decision).toBe('DENY');
    expect(result.reasonCodes).toEqual([DenyReason.NO_EXPLICIT_ALLOW]);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed gates
// ---------------------------------------------------------------------------

describe('fail-closed gates', () => {
  it('returns INDETERMINATE when the policy store is unavailable, even with a matching allow', () => {
    const result = evaluatePolicy(baseInput({ policyStoreAvailable: false }), makeRevision(apPolicy()));
    expect(result.decision).toBe('INDETERMINATE');
    expect(result.reasonCodes).toEqual([IndeterminateReason.POLICY_EVALUATOR_UNAVAILABLE]);
    expect(result.indeterminateReasons).toEqual([IndeterminateReason.POLICY_EVALUATOR_UNAVAILABLE]);
    expect(result.rulesEvaluated).toHaveLength(0);
  });

  it('denies side-effecting tools under emergency stop, degraded and quarantine modes', () => {
    const modes = [
      ['EMERGENCY_STOP', DenyReason.EMERGENCY_STOP_ACTIVE],
      ['DEGRADED_READ_ONLY', DenyReason.WRITE_DISABLED_DEGRADED_MODE],
      ['QUARANTINE', DenyReason.QUARANTINE_ACTIVE],
    ] as const;
    for (const [mode, code] of modes) {
      const result = evaluatePolicy(baseInput({ enforcementMode: mode }), makeRevision(apPolicy()));
      expect(result.decision).toBe('DENY');
      expect(result.reasonCodes).toEqual([code]);
    }
  });

  it('keeps reads available under emergency stop', () => {
    const input = baseInput({
      enforcementMode: 'EMERGENCY_STOP',
      toolName: 'invoice.read',
      operation: 'read',
      arguments: { invoice_id: 'INV-2041' },
    });
    const result = evaluatePolicy(input, makeRevision(apPolicy()));
    expect(result.decision).toBe('ALLOW');
  });

  it('evaluates normally in observe-only mode; the caller enforces non-blocking at the broker', () => {
    const result = evaluatePolicy(baseInput({ enforcementMode: 'OBSERVE_ONLY' }), makeRevision(apPolicy()));
    expect(result.decision).toBe('ALLOW');
  });
});

// ---------------------------------------------------------------------------
// Unresolvable fields
// ---------------------------------------------------------------------------

describe('unresolvable fields', () => {
  it('returns INDETERMINATE, never ALLOW, when no allow path can be fully evaluated', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({
          id: 'allow-verified-vendor',
          effect: 'ALLOW',
          reason_code: 'VENDOR_VERIFIED',
          when: { any: [cond('vendor.status', 'equals', 'VERIFIED')] },
        }),
      ],
    };
    const result = evaluatePolicy(baseInput({ vendor: undefined }), makeRevision(doc));
    expect(result.decision).toBe('INDETERMINATE');
    expect(result.reasonCodes).toEqual([IndeterminateReason.AUTHORITATIVE_STATE_UNAVAILABLE]);
  });

  it('keeps a matched deny standing when an allow rule is unresolvable', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({
          id: 'deny-payments',
          effect: 'DENY',
          reason_code: 'TOOL_NOT_ALLOWED',
          when: { any: [cond('tool.name', 'equals', 'payment.execute')] },
        }),
        makeRule({
          id: 'allow-verified-vendor',
          effect: 'ALLOW',
          reason_code: 'VENDOR_VERIFIED',
          when: { any: [cond('vendor.status', 'equals', 'VERIFIED')] },
        }),
      ],
    };
    const result = evaluatePolicy(baseInput({ vendor: undefined }), makeRevision(doc));
    expect(result.decision).toBe('DENY');
    expect(result.reasonCodes).toEqual(['TOOL_NOT_ALLOWED']);
  });

  it('treats FALSE as dominating UNKNOWN in `all`, and TRUE as dominating in `any`', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({
          id: 'allow-all-with-false',
          effect: 'ALLOW',
          reason_code: 'WITHIN_LIMIT',
          when: {
            all: [
              cond('vendor.status', 'equals', 'VERIFIED'),
              cond('tool.name', 'equals', 'no.such.tool'),
            ],
          },
        }),
        makeRule({
          id: 'allow-any-with-true',
          effect: 'ALLOW',
          reason_code: 'TOOL_ALLOWED',
          when: {
            any: [
              cond('vendor.status', 'equals', 'VERIFIED'),
              cond('tool.name', 'equals', 'payment.execute'),
            ],
          },
        }),
      ],
    };
    const result = evaluatePolicy(baseInput({ vendor: undefined }), makeRevision(doc));
    // The `any` rule matches on the definite TRUE; the `all` rule is FALSE, not unknown.
    expect(result.decision).toBe('ALLOW');
    expect(result.reasonCodes).toEqual(['TOOL_ALLOWED']);
  });

  it('fails closed on an invalid regex instead of throwing', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({
          id: 'allow-regex',
          effect: 'ALLOW',
          reason_code: 'TASK_SCOPE_MATCHED',
          when: { any: [cond('task.purpose', 'matches_regex', '([')] },
        }),
      ],
    };
    const result = evaluatePolicy(baseInput(), makeRevision(doc));
    expect(result.decision).toBe('INDETERMINATE');
  });
});

// ---------------------------------------------------------------------------
// Model signals: escalate, never allow
// ---------------------------------------------------------------------------

describe('model signals', () => {
  it('neuters an ALLOW rule that reads model.* fields', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({
          id: 'allow-when-model-calm',
          effect: 'ALLOW',
          reason_code: 'WITHIN_LIMIT',
          when: { any: [cond('model.max_injection_confidence', 'less_than', 0.1)] },
        }),
      ],
    };
    const hints = injectionHints();
    hints.instructionInjectionIndicators = [];
    const result = evaluatePolicy(baseInput({ riskHints: hints }), makeRevision(doc));
    expect(result.decision).toBe('DENY');
    expect(result.reasonCodes).toEqual([DenyReason.NO_EXPLICIT_ALLOW]);
    expect(result.rulesEvaluated).toHaveLength(1);
    expect(result.rulesEvaluated[0]?.matched).toBe(false);
    expect(result.rulesEvaluated[0]?.detail).toContain('neutered');
  });

  it('escalates advisory injection signals to human approval with risk signals attached', () => {
    const result = evaluatePolicy(baseInput({ riskHints: injectionHints() }), makeRevision(apPolicy()));
    expect(result.decision).toBe('REQUIRE_APPROVAL');
    expect(result.reasonCodes).toContain(ApprovalReason.MODEL_RISK_SIGNAL_ESCALATION);
    expect(result.approvalReasons).toContain(ApprovalReason.MODEL_RISK_SIGNAL_ESCALATION);
    expect(result.riskSignals).toHaveLength(2);
    expect(result.riskSignals.map((s) => s.severity)).toEqual(['CRITICAL', 'MEDIUM']);
    for (const signal of result.riskSignals) {
      expect(signal.source).toBe('MODEL_ADVISORY');
    }
  });

  it('caps a would-be allow at approval when a required model signal is missing', () => {
    const result = evaluatePolicy(
      baseInput({ requiredModelSignalUnavailable: true }),
      makeRevision(apPolicy()),
    );
    expect(result.decision).toBe('REQUIRE_APPROVAL');
    expect(result.reasonCodes).toEqual([ApprovalReason.REQUIRED_SIGNAL_UNAVAILABLE]);
    expect(result.requiredApprovals).toBe(1);
  });

  it('ignores the missing-signal flag when no in-scope rule reads model.* fields', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({
          id: 'allow-low-value',
          effect: 'ALLOW',
          reason_code: 'WITHIN_LIMIT',
          when: { any: [cond('arguments.amount_minor', 'less_than_or_equal', 500000)] },
        }),
      ],
    };
    const result = evaluatePolicy(baseInput({ requiredModelSignalUnavailable: true }), makeRevision(doc));
    expect(result.decision).toBe('ALLOW');
  });
});

// ---------------------------------------------------------------------------
// Approval quorum and scope filtering
// ---------------------------------------------------------------------------

describe('approval quorum and scope', () => {
  it('outranks allow and takes the maximum quorum across matching approval rules', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({
          id: 'approval-small',
          effect: 'REQUIRE_APPROVAL',
          reason_code: 'AMOUNT_OVER_APPROVAL_THRESHOLD',
          approval: quorum(1),
          when: { any: [cond('arguments.amount_minor', 'greater_than', 500000)] },
        }),
        makeRule({
          id: 'approval-big',
          effect: 'REQUIRE_APPROVAL',
          reason_code: 'DUAL_APPROVAL_REQUIRED',
          approval: quorum(2),
          when: { any: [cond('arguments.amount_minor', 'greater_than', 800000)] },
        }),
        makeRule({
          id: 'allow-low',
          effect: 'ALLOW',
          reason_code: 'WITHIN_LIMIT',
          when: { any: [cond('arguments.amount_minor', 'less_than_or_equal', 2000000)] },
        }),
      ],
    };
    const input = baseInput({
      arguments: { ...baseInput().arguments, amount_minor: 1000000 },
    });
    const result = evaluatePolicy(input, makeRevision(doc));
    expect(result.decision).toBe('REQUIRE_APPROVAL');
    expect(result.requiredApprovals).toBe(2);
    expect(result.reasonCodes).toContain('AMOUNT_OVER_APPROVAL_THRESHOLD');
    expect(result.reasonCodes).toContain('DUAL_APPROVAL_REQUIRED');
  });

  it('excludes out-of-scope rules from rulesEvaluated', () => {
    const result = evaluatePolicy(baseInput(), makeRevision(apPolicy()));
    const ids = result.rulesEvaluated.map((r) => r.ruleId);
    expect(ids).not.toContain('approval-vendor-change');
    expect(ids).not.toContain('allow-reads');
  });
});

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

describe('resolveFields', () => {
  it('resolves every known field with an explanation', () => {
    const fields = resolveFields(baseInput());
    expect(fields).toHaveLength(POLICY_FIELDS.length);
    for (const f of fields) {
      expect(typeof f.detail).toBe('string');
      expect(f.detail.length).toBeGreaterThan(0);
      if (f.resolved) expect(f.value).not.toBeNull();
      else expect(f.value).toBeNull();
    }
  });

  it('computes derived comparisons from authoritative state', () => {
    const byField = new Map(resolveFields(baseInput()).map((f) => [f.field, f]));
    expect(byField.get('principal.role')?.value).toBe('SERVICE_AGENT');
    expect(byField.get('time.hour_utc')?.value).toBe(12);
    expect(byField.get('time.day_of_week_utc')?.value).toBe(1);
    expect(byField.get('vendor.beneficiary_matches_verified')?.value).toBe(true);
    expect(byField.get('purchase_order.matched')?.value).toBe(true);
    expect(byField.get('purchase_order.amount_covers')?.value).toBe(true);
    expect(byField.get('evidence.count')?.value).toBe(2);
    expect(byField.get('vendor.destination_allowed')?.value).toBe(true);
  });

  it('reports banking-change age in hours and flags unverified changes', () => {
    const input = baseInput({
      vendor: {
        ...baseVendor,
        bankingChangedAt: new Date('2026-10-26T06:00:00Z'),
        bankingChangeVerifiedAt: null,
      },
    });
    const byField = new Map(resolveFields(input).map((f) => [f.field, f]));
    expect(byField.get('vendor.banking_change_hours_ago')?.value).toBeCloseTo(6, 5);
    expect(byField.get('vendor.banking_change_verified')?.value).toBe(false);
  });

  it('leaves model fields unresolved when no signal was produced', () => {
    const byField = new Map(resolveFields(baseInput()).map((f) => [f.field, f]));
    expect(byField.get('model.enabled')?.value).toBe(false);
    expect(byField.get('model.signal_present')?.resolved).toBe(false);
    expect(byField.get('model.max_injection_confidence')?.resolved).toBe(false);
    expect(byField.get('model.missing_evidence_count')?.resolved).toBe(false);
  });

  it('matches evidence kinds by membership', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({
          id: 'allow-with-invoice',
          effect: 'ALLOW',
          reason_code: 'EVIDENCE_PRESENT',
          when: { any: [cond('evidence.has_kind', 'equals', 'invoice')] },
        }),
      ],
    };
    expect(evaluatePolicy(baseInput(), makeRevision(doc)).decision).toBe('ALLOW');
    expect(evaluatePolicy(baseInput({ evidenceRefs: [] }), makeRevision(doc)).decision).toBe('DENY');
  });
});

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

describe('result envelope', () => {
  it('carries revision identity, input clock and cache flag', () => {
    const input = baseInput();
    const result = evaluatePolicy(input, makeRevision(apPolicy()));
    expect(result.policyRevisionId).toBe('polrev_test_001');
    expect(result.policyRevisionNumber).toBe(7);
    expect(result.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.evaluatedAt.getTime()).toBe(input.requestedAt.getTime());
    expect(result.fromCache).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Linter
// ---------------------------------------------------------------------------

describe('lintPolicy', () => {
  it('reports no errors for the AP policy', () => {
    const errors = lintPolicy(apPolicy()).filter((f) => f.severity === 'ERROR');
    expect(errors).toEqual([]);
  });

  it('flags duplicate rule ids as errors', () => {
    const doc = apPolicy();
    doc.rules = [...doc.rules, { ...doc.rules[0]! }];
    const findings = lintPolicy(doc).filter((f) => f.code === 'DUPLICATE_RULE_ID');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('ERROR');
  });

  it('flags model fields in allow rules as errors', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({
          id: 'bad-allow',
          effect: 'ALLOW',
          reason_code: 'WITHIN_LIMIT',
          when: { any: [cond('model.signal_present', 'not_exists')] },
        }),
      ],
    };
    const findings = lintPolicy(doc).filter((f) => f.code === 'MODEL_FIELD_IN_ALLOW_RULE');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('ERROR');
  });

  it('flags a non-deny default as an error', () => {
    const doc = apPolicy() as unknown as { default_effect: string; rules: PolicyRule[] };
    const findings = lintPolicy({ ...apPolicy(), default_effect: doc.default_effect as 'DENY' }).filter(
      (f) => f.code === 'MISSING_DEFAULT_DENY',
    );
    expect(findings).toHaveLength(0);
    const bad = { ...apPolicy(), default_effect: 'ALLOW' } as unknown as PolicyDocument;
    expect(lintPolicy(bad).filter((f) => f.code === 'MISSING_DEFAULT_DENY')).toHaveLength(1);
  });

  it('flags wildcard scopes, unknown tools and unreachable rules', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({ id: 'wild', effect: 'DENY', reason_code: 'DEFAULT_DENY', scope: { tools: ['*'] }, when: { none: [] } }),
        makeRule({
          id: 'partial-unknown',
          effect: 'DENY',
          reason_code: 'DEFAULT_DENY',
          scope: { tools: ['payment.execute', 'nope.unknown'] },
          when: { none: [] },
        }),
        makeRule({
          id: 'all-unknown',
          effect: 'DENY',
          reason_code: 'DEFAULT_DENY',
          scope: { tools: ['nope.unknown'] },
          when: { none: [] },
        }),
      ],
    };
    const codes = lintPolicy(doc).map((f) => `${f.code}:${f.ruleIds.join(',')}`);
    expect(codes).toContain('OVERLY_BROAD_WILDCARD:wild');
    expect(codes).toContain('UNKNOWN_TOOL_IN_SCOPE:partial-unknown');
    expect(codes).toContain('UNREACHABLE_RULE:all-unknown');
  });

  it('flags empty-scope allows, missing allows and disabled rules', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({ id: 'open-allow', effect: 'ALLOW', reason_code: 'TOOL_ALLOWED', when: { none: [] } }),
        makeRule({ id: 'sleeping', effect: 'DENY', reason_code: 'DEFAULT_DENY', enabled: false, when: { none: [] } }),
      ],
    };
    const codes = lintPolicy(doc).map((f) => f.code);
    expect(codes).toContain('EMPTY_SCOPE_ON_ALLOW');
    expect(codes).toContain('DISABLED_RULE');
    expect(codes).not.toContain('NO_ALLOW_RULE');
    const noAllow: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [makeRule({ id: 'only-deny', effect: 'DENY', reason_code: 'DEFAULT_DENY', when: { none: [] } })],
    };
    expect(lintPolicy(noAllow).map((f) => f.code)).toContain('NO_ALLOW_RULE');
  });

  it('flags single-approver high-risk rules and suspect amount units', () => {
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({
          id: 'solo-approval',
          effect: 'REQUIRE_APPROVAL',
          reason_code: 'AMOUNT_OVER_APPROVAL_THRESHOLD',
          scope: { tools: ['payment.execute'] },
          approval: quorum(1),
          when: { any: [cond('arguments.amount_minor', 'greater_than', 50)] },
        }),
        makeRule({
          id: 'dual-approval',
          effect: 'REQUIRE_APPROVAL',
          reason_code: 'DUAL_APPROVAL_REQUIRED',
          scope: { tools: ['payment.execute'] },
          approval: quorum(2),
          when: { any: [cond('arguments.amount_minor', 'greater_than', 500000)] },
        }),
      ],
    };
    const findings = lintPolicy(doc);
    expect(findings.filter((f) => f.code === 'APPROVAL_QUORUM_ONE_FOR_HIGH_RISK').map((f) => f.ruleIds)).toEqual([
      ['solo-approval'],
    ]);
    expect(findings.filter((f) => f.code === 'AMOUNT_UNIT_SUSPECT').map((f) => f.ruleIds)).toEqual([
      ['solo-approval'],
    ]);
  });

  it('flags textually overlapping allow/deny pairs', () => {
    const when: ConditionGroup = { any: [cond('arguments.amount_minor', 'greater_than', 100)] };
    const doc: PolicyDocument = {
      schema_version: 'policy.v1',
      default_effect: 'DENY',
      rules: [
        makeRule({ id: 'allow-x', effect: 'ALLOW', reason_code: 'WITHIN_LIMIT', scope: { tools: ['payment.execute'] }, when }),
        makeRule({ id: 'deny-x', effect: 'DENY', reason_code: 'AMOUNT_OVER_LIMIT', scope: { tools: ['payment.execute'] }, when }),
      ],
    };
    const findings = lintPolicy(doc).filter((f) => f.code === 'OVERLAPPING_ALLOW_DENY');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleIds).toEqual(['allow-x', 'deny-x']);
  });
});

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

describe('simulatePolicy', () => {
  it('evaluates every case without side effects', () => {
    const revision = makeRevision(apPolicy());
    const results = simulatePolicy(
      [
        { fixtureId: 'benign', label: 'benign invoice', input: baseInput() },
        { fixtureId: 'big', label: 'large invoice', input: baseInput({ arguments: { ...baseInput().arguments, amount_minor: 600000 } }) },
      ],
      revision,
    );
    expect(results.map((r) => [r.fixtureId, r.result.decision])).toEqual([
      ['benign', 'ALLOW'],
      ['big', 'REQUIRE_APPROVAL'],
    ]);
  });

  it('refuses to silently truncate beyond maxFixtures', () => {
    const revision = makeRevision(apPolicy());
    const cases = [
      { fixtureId: 'a', label: 'a', input: baseInput() },
      { fixtureId: 'b', label: 'b', input: baseInput() },
      { fixtureId: 'c', label: 'c', input: baseInput() },
    ];
    expect(() => simulatePolicy(cases, revision, { maxFixtures: 2 })).toThrow(RangeError);
    expect(simulatePolicy(cases, revision, { maxFixtures: 3 })).toHaveLength(3);
    expect(DEFAULT_MAX_FIXTURES).toBeGreaterThan(0);
  });
});
