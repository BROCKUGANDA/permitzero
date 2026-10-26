/**
 * Policy document schema — the policy-as-data DSL evaluated by @permitzero/policy
 * and edited in the Policy Studio UI.
 *
 * Design constraints that matter for security:
 *
 *  1. Fields are a *closed enum*, not a path expression. There is no JSONPath or
 *     expression interpreter, so a hostile policy document cannot reach data it
 *     was not given, and evaluation is deterministic and fast (PRD §12.7 hot path).
 *  2. `default_effect` is always DENY. The schema rejects any other value, which
 *     makes "no allow rule matched" a deny by construction (FR-023, Master §5.3).
 *  3. Deny precedence is *structural*, not priority-ordered: a matching DENY can
 *     never be outvoted by an ALLOW regardless of rule order or priority numbers.
 *  4. Published revisions are immutable; edits create a new revision (FR-024).
 *     The document hash is computed over its canonical form.
 */
import { z } from 'zod';
import { ALL_REASON_CODES } from '@permitzero/domain';

export const POLICY_SCHEMA_VERSION = 'policy.v1';

/**
 * Every field the engine knows how to resolve from authoritative state. Adding a
 * field means adding a resolver — an unresolvable field yields INDETERMINATE,
 * never `false`, so a typo in a policy cannot silently weaken it.
 */
export const PolicyField = {
  // Action identity
  TOOL_NAME: 'tool.name',
  OPERATION: 'tool.operation',
  ENVIRONMENT: 'environment',
  AGENT_ID: 'agent.id',
  AGENT_FRAMEWORK: 'agent.framework',
  AGENT_STATUS: 'agent.status',
  PRINCIPAL_ROLE: 'principal.role',
  RUN_ACTION_COUNT: 'run.action_count',
  TASK_PURPOSE: 'task.purpose',

  // Proposed arguments
  ARG_AMOUNT_MINOR: 'arguments.amount_minor',
  ARG_CURRENCY: 'arguments.currency',
  ARG_VENDOR_ID: 'arguments.vendor_id',
  ARG_BENEFICIARY_REF: 'arguments.beneficiary_ref',
  ARG_INVOICE_ID: 'arguments.invoice_id',
  ARG_PURCHASE_ORDER_ID: 'arguments.purchase_order_id',
  ARG_DESTINATION_REF: 'arguments.destination_ref',
  ARG_TARGET_TABLE: 'arguments.target_table',
  ARG_RECORD_COUNT: 'arguments.record_count',
  ARG_DATA_CLASSIFICATION: 'arguments.data_classification',

  // Authoritative vendor state
  VENDOR_EXISTS: 'vendor.exists',
  VENDOR_STATUS: 'vendor.status',
  VENDOR_ACCOUNT_AGE_DAYS: 'vendor.account_age_days',
  VENDOR_BENEFICIARY_MATCHES_VERIFIED: 'vendor.beneficiary_matches_verified',
  VENDOR_BANKING_CHANGE_HOURS_AGO: 'vendor.banking_change_hours_ago',
  VENDOR_BANKING_CHANGE_VERIFIED: 'vendor.banking_change_verified',
  VENDOR_DESTINATION_ALLOWED: 'vendor.destination_allowed',
  VENDOR_DATA_CLASSIFICATION: 'vendor.data_classification',

  // Invoice / purchase-order match
  INVOICE_EXISTS: 'invoice.exists',
  INVOICE_VENDOR_MATCHES: 'invoice.vendor_matches',
  INVOICE_AMOUNT_MATCHES_ARGUMENT: 'invoice.amount_matches_argument',
  INVOICE_CURRENCY_MATCHES_ARGUMENT: 'invoice.currency_matches_argument',
  PURCHASE_ORDER_EXISTS: 'purchase_order.exists',
  PURCHASE_ORDER_MATCHED: 'purchase_order.matched',
  PURCHASE_ORDER_AMOUNT_COVERS: 'purchase_order.amount_covers',
  PURCHASE_ORDER_VENDOR_MATCHES: 'purchase_order.vendor_matches',

  // Evidence
  EVIDENCE_HAS_KIND: 'evidence.has_kind',
  EVIDENCE_COUNT: 'evidence.count',
  EVIDENCE_ALL_UNTRUSTED_LABELLED: 'evidence.all_untrusted_labelled',

  // Connector
  CONNECTOR_EXISTS: 'connector.exists',
  CONNECTOR_STATUS: 'connector.status',
  CONNECTOR_SIMULATED: 'connector.simulated',
  CONNECTOR_TOOL_ALLOWED: 'connector.tool_allowed',

  // Aggregate controls
  BUDGET_SPEND_MINOR: 'budget.spend_minor',
  VELOCITY_COUNT: 'velocity.count',
  TIME_HOUR_UTC: 'time.hour_utc',
  TIME_DAY_OF_WEEK_UTC: 'time.day_of_week_utc',

  // Advisory model signals — may escalate, may never allow (FR-071).
  MODEL_ENABLED: 'model.enabled',
  MODEL_SIGNAL_PRESENT: 'model.signal_present',
  MODEL_MAX_INJECTION_CONFIDENCE: 'model.max_injection_confidence',
  MODEL_MISSING_EVIDENCE_COUNT: 'model.missing_evidence_count',
} as const;
export type PolicyField = (typeof PolicyField)[keyof typeof PolicyField];

export const POLICY_FIELDS = Object.values(PolicyField) as readonly PolicyField[];

/** Field → value type, so the linter can reject a string comparison against an
 * integer threshold (PRD §7.3.D: "invalid amount units"). */
export const FIELD_VALUE_TYPE: Readonly<Record<PolicyField, 'string' | 'number' | 'boolean' | 'enum'>> =
  {
    'tool.name': 'string',
    'tool.operation': 'string',
    environment: 'enum',
    'agent.id': 'string',
    'agent.framework': 'string',
    'agent.status': 'enum',
    'principal.role': 'enum',
    'run.action_count': 'number',
    'task.purpose': 'string',
    'arguments.amount_minor': 'number',
    'arguments.currency': 'string',
    'arguments.vendor_id': 'string',
    'arguments.beneficiary_ref': 'string',
    'arguments.invoice_id': 'string',
    'arguments.purchase_order_id': 'string',
    'arguments.destination_ref': 'string',
    'arguments.target_table': 'string',
    'arguments.record_count': 'number',
    'arguments.data_classification': 'string',
    'vendor.exists': 'boolean',
    'vendor.status': 'enum',
    'vendor.account_age_days': 'number',
    'vendor.beneficiary_matches_verified': 'boolean',
    'vendor.banking_change_hours_ago': 'number',
    'vendor.banking_change_verified': 'boolean',
    'vendor.destination_allowed': 'boolean',
    'vendor.data_classification': 'string',
    'invoice.exists': 'boolean',
    'invoice.vendor_matches': 'boolean',
    'invoice.amount_matches_argument': 'boolean',
    'invoice.currency_matches_argument': 'boolean',
    'purchase_order.exists': 'boolean',
    'purchase_order.matched': 'boolean',
    'purchase_order.amount_covers': 'boolean',
    'purchase_order.vendor_matches': 'boolean',
    'evidence.has_kind': 'string',
    'evidence.count': 'number',
    'evidence.all_untrusted_labelled': 'boolean',
    'connector.exists': 'boolean',
    'connector.status': 'enum',
    'connector.simulated': 'boolean',
    'connector.tool_allowed': 'boolean',
    'budget.spend_minor': 'number',
    'velocity.count': 'number',
    'time.hour_utc': 'number',
    'time.day_of_week_utc': 'number',
    'model.enabled': 'boolean',
    'model.signal_present': 'string',
    'model.max_injection_confidence': 'number',
    'model.missing_evidence_count': 'number',
  };

export const PolicyOperator = {
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  LESS_THAN: 'less_than',
  LESS_THAN_OR_EQUAL: 'less_than_or_equal',
  GREATER_THAN: 'greater_than',
  GREATER_THAN_OR_EQUAL: 'greater_than_or_equal',
  IN: 'in',
  NOT_IN: 'not_in',
  CONTAINS: 'contains',
  MATCHES_REGEX: 'matches_regex',
  IS_TRUE: 'is_true',
  IS_FALSE: 'is_false',
  EXISTS: 'exists',
  NOT_EXISTS: 'not_exists',
} as const;
export type PolicyOperator = (typeof PolicyOperator)[keyof typeof PolicyOperator];

/** Operators that take no value. */
export const VALUELESS_OPERATORS: readonly PolicyOperator[] = [
  PolicyOperator.IS_TRUE,
  PolicyOperator.IS_FALSE,
  PolicyOperator.EXISTS,
  PolicyOperator.NOT_EXISTS,
];

/** Operators whose value must be an array. */
export const LIST_OPERATORS: readonly PolicyOperator[] = [
  PolicyOperator.IN,
  PolicyOperator.NOT_IN,
];

export const RuleEffect = {
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
} as const;
export type RuleEffect = (typeof RuleEffect)[keyof typeof RuleEffect];

const conditionValueSchema = z.union([
  z.string().max(512),
  z.number().int().safe(),
  z.boolean(),
  z.array(z.union([z.string().max(512), z.number().int().safe()])).max(64),
  z.null(),
]);

export const conditionSchema = z
  .object({
    field: z.enum(POLICY_FIELDS as [PolicyField, ...PolicyField[]]),
    op: z.nativeEnum(PolicyOperator),
    value: conditionValueSchema.optional(),
    /** Human-readable explanation surfaced in the decision drawer. */
    detail: z.string().max(280).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const valueless = VALUELESS_OPERATORS.includes(c.op);
    const listOp = LIST_OPERATORS.includes(c.op);
    if (valueless && c.value !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `operator "${c.op}" takes no value`,
      });
    }
    if (!valueless && c.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `operator "${c.op}" requires a value`,
      });
    }
    if (listOp && !Array.isArray(c.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `operator "${c.op}" requires an array value`,
      });
    }
    if (!listOp && Array.isArray(c.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `operator "${c.op}" does not accept an array value`,
      });
    }
    // Type-check the value against the field's declared type so an amount rule
    // cannot be written against a string literal.
    const declared = FIELD_VALUE_TYPE[c.field];
    if (!valueless && c.value !== undefined && !Array.isArray(c.value)) {
      if (declared === 'number' && typeof c.value !== 'number') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: `field "${c.field}" expects an integer value`,
        });
      }
      if (declared === 'boolean' && typeof c.value !== 'boolean') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: `field "${c.field}" expects a boolean value`,
        });
      }
      if ((declared === 'string' || declared === 'enum') && typeof c.value !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: `field "${c.field}" expects a string value`,
        });
      }
    }
    if (c.op === PolicyOperator.MATCHES_REGEX && typeof c.value === 'string') {
      try {
        new RegExp(c.value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'invalid regular expression',
        });
      }
    }
  });
export type Condition = z.infer<typeof conditionSchema>;

/** AND/OR/NOT groups with explicit precedence: `none` binds tightest, then
 * `all`, then `any` (FR-023 requires clear precedence). */
export const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z
    .object({
      all: z.array(z.union([conditionSchema, conditionGroupSchema])).max(32).optional(),
      any: z.array(z.union([conditionSchema, conditionGroupSchema])).max(32).optional(),
      none: z.array(z.union([conditionSchema, conditionGroupSchema])).max(32).optional(),
    })
    .strict()
    .refine(
      (g) => g.all !== undefined || g.any !== undefined || g.none !== undefined,
      { message: 'a condition group requires at least one of all/any/none' },
    ),
);
export interface ConditionGroup {
  all?: ReadonlyArray<Condition | ConditionGroup>;
  any?: ReadonlyArray<Condition | ConditionGroup>;
  none?: ReadonlyArray<Condition | ConditionGroup>;
}

export const ruleScopeSchema = z
  .object({
    /** Exact tool names. `"*"` is permitted but flagged by the linter as overly
     * broad, because a wildcard allow is how a policy accidentally grants
     * everything (PRD §7.3.D). */
    tools: z.array(z.string().min(1).max(128)).max(32).optional(),
    operations: z.array(z.string().min(1).max(128)).max(32).optional(),
    environments: z.array(z.enum(['DEMO', 'STAGING', 'PRODUCTION'])).optional(),
    agent_ids: z.array(z.string().min(1).max(64)).max(64).optional(),
    resource_refs: z.array(z.string().min(1).max(256)).max(64).optional(),
  })
  .strict();
export type RuleScope = z.infer<typeof ruleScopeSchema>;

export const approvalRequirementSchema = z
  .object({
    required_approvals: z.number().int().min(1).max(5),
    require_distinct_approvers: z.boolean().default(true),
    require_independent_verification: z.boolean().default(false),
    require_mfa: z.boolean().default(false),
    ttl_seconds: z.number().int().min(30).max(86400).default(900),
  })
  .strict();
export type ApprovalRequirement = z.infer<typeof approvalRequirementSchema>;

export const policyRuleSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-_]*$/, 'rule id must be lowercase kebab/snake'),
    description: z.string().min(1).max(280),
    effect: z.nativeEnum(RuleEffect),
    reason_code: z.string().min(1).max(96),
    /** Higher runs first *within* an effect class. Deny always beats allow
     * regardless of this number. */
    priority: z.number().int().min(0).max(10000).default(100),
    enabled: z.boolean().default(true),
    scope: ruleScopeSchema.default({}),
    when: conditionGroupSchema,
    approval: approvalRequirementSchema.optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (!ALL_REASON_CODES.has(rule.reason_code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason_code'],
        message: `unknown reason code "${rule.reason_code}"`,
      });
    }
    if (rule.effect === RuleEffect.REQUIRE_APPROVAL && rule.approval === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval'],
        message: 'a REQUIRE_APPROVAL rule must declare an approval requirement',
      });
    }
    if (rule.effect === RuleEffect.ALLOW && rule.approval !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval'],
        message: 'an ALLOW rule must not declare an approval requirement',
      });
    }
  });
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const policyDocumentSchema = z
  .object({
    schema_version: z.literal(POLICY_SCHEMA_VERSION),
    /** Locked to DENY. A policy that defaults to allow is not a policy. */
    default_effect: z.literal('DENY'),
    /** Tenant-configured thresholds live here so the UI can show units and the
     * linter can flag an amount written in major units. */
    parameters: z.record(z.string(), z.union([z.number().int().safe(), z.string(), z.boolean()])).optional(),
    rules: z.array(policyRuleSchema).min(1).max(200),
  })
  .strict();
export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

/** Linter findings surfaced in Policy Studio before publish (PRD §7.3.D). */
export const PolicyLintSeverity = {
  ERROR: 'ERROR',
  WARNING: 'WARNING',
  INFO: 'INFO',
} as const;
export type PolicyLintSeverity = (typeof PolicyLintSeverity)[keyof typeof PolicyLintSeverity];

export const PolicyLintCode = {
  MISSING_DEFAULT_DENY: 'MISSING_DEFAULT_DENY',
  DUPLICATE_RULE_ID: 'DUPLICATE_RULE_ID',
  OVERLAPPING_ALLOW_DENY: 'OVERLAPPING_ALLOW_DENY',
  UNREACHABLE_RULE: 'UNREACHABLE_RULE',
  OVERLY_BROAD_WILDCARD: 'OVERLY_BROAD_WILDCARD',
  AMOUNT_UNIT_SUSPECT: 'AMOUNT_UNIT_SUSPECT',
  NO_ALLOW_RULE: 'NO_ALLOW_RULE',
  DISABLED_RULE: 'DISABLED_RULE',
  UNKNOWN_TOOL_IN_SCOPE: 'UNKNOWN_TOOL_IN_SCOPE',
  APPROVAL_QUORUM_ONE_FOR_HIGH_RISK: 'APPROVAL_QUORUM_ONE_FOR_HIGH_RISK',
  MODEL_FIELD_IN_ALLOW_RULE: 'MODEL_FIELD_IN_ALLOW_RULE',
  EMPTY_SCOPE_ON_ALLOW: 'EMPTY_SCOPE_ON_ALLOW',
} as const;
export type PolicyLintCode = (typeof PolicyLintCode)[keyof typeof PolicyLintCode];

export interface PolicyLintFinding {
  code: PolicyLintCode;
  severity: PolicyLintSeverity;
  ruleIds: string[];
  message: string;
}
