/**
 * Field resolution: turn a `PolicyEvaluationInput` into the flat field table the
 * condition matcher evaluates against.
 *
 * Three resolution states, kept distinct on purpose:
 *  - `resolved` — a definite value was computed from authoritative state.
 *  - `absent` — the value is definitely not there (argument omitted, vendor
 *    looked up and not found). Value comparisons are false; `not_exists` is
 *    true.
 *  - `unknown` — the value could not be determined (lookup never performed,
 *    model signal missing, malformed input). Any condition on it is UNKNOWN,
 *    which can never contribute an allow.
 *
 * The public `resolveFields` projects this to the contract shape; the matcher
 * uses the internal map so it can tell `absent` from `unknown`.
 */
import type { PolicyEvaluationInput } from '@permitzero/domain';
import { POLICY_FIELDS, PolicyField } from '@permitzero/schemas';

export interface ResolvedField {
  field: PolicyField;
  resolved: boolean;
  value: string | number | boolean | null;
  detail: string;
}

export type ResolutionStatus = 'resolved' | 'absent' | 'unknown';

export interface InternalResolved extends ResolvedField {
  status: ResolutionStatus;
  /**
   * Set members for multi-valued fields (`evidence.has_kind`,
   * `model.signal_present`). The scalar `value` is the display form (sorted,
   * comma-joined); the matcher tests membership against this list.
   */
  setValues: readonly string[] | null;
}

interface ResolverContext {
  input: PolicyEvaluationInput;
  /** Milliseconds since epoch of `requestedAt`, or null when unusable. */
  requestedMs: number | null;
}

function resolved(
  field: PolicyField,
  value: string | number | boolean,
  detail: string,
  setValues: readonly string[] | null = null,
): InternalResolved {
  return { field, resolved: true, status: 'resolved', value, detail, setValues };
}

function absent(field: PolicyField, detail: string): InternalResolved {
  return { field, resolved: false, status: 'absent', value: null, detail, setValues: null };
}

function unknown(field: PolicyField, detail: string): InternalResolved {
  return { field, resolved: false, status: 'unknown', value: null, detail, setValues: null };
}

function argString(ctx: ResolverContext, key: string): string | undefined {
  const v = ctx.input.arguments[key];
  return typeof v === 'string' ? v : undefined;
}

function argInt(ctx: ResolverContext, key: string): number | undefined {
  const v = ctx.input.arguments[key];
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;
}

function msOf(d: Date | null | undefined): number | null {
  if (!(d instanceof Date)) return null;
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

const RESOLVERS: Record<PolicyField, (ctx: ResolverContext) => InternalResolved> = {
  [PolicyField.TOOL_NAME]: (ctx) =>
    typeof ctx.input.toolName === 'string'
      ? resolved(PolicyField.TOOL_NAME, ctx.input.toolName, `tool ${ctx.input.toolName}`)
      : unknown(PolicyField.TOOL_NAME, 'tool name is not a string'),

  [PolicyField.OPERATION]: (ctx) =>
    typeof ctx.input.operation === 'string'
      ? resolved(PolicyField.OPERATION, ctx.input.operation, `operation ${ctx.input.operation}`)
      : unknown(PolicyField.OPERATION, 'operation is not a string'),

  [PolicyField.ENVIRONMENT]: (ctx) =>
    typeof ctx.input.environment === 'string'
      ? resolved(PolicyField.ENVIRONMENT, ctx.input.environment, `environment ${ctx.input.environment}`)
      : unknown(PolicyField.ENVIRONMENT, 'environment is not a string'),

  [PolicyField.AGENT_ID]: (ctx) =>
    typeof ctx.input.agent.agentId === 'string'
      ? resolved(PolicyField.AGENT_ID, ctx.input.agent.agentId, `agent ${ctx.input.agent.agentId}`)
      : unknown(PolicyField.AGENT_ID, 'agent id is not a string'),

  [PolicyField.AGENT_FRAMEWORK]: (ctx) =>
    typeof ctx.input.agent.framework === 'string'
      ? resolved(PolicyField.AGENT_FRAMEWORK, ctx.input.agent.framework, `framework ${ctx.input.agent.framework}`)
      : unknown(PolicyField.AGENT_FRAMEWORK, 'agent framework is not a string'),

  [PolicyField.AGENT_STATUS]: (ctx) =>
    typeof ctx.input.agent.status === 'string'
      ? resolved(PolicyField.AGENT_STATUS, ctx.input.agent.status, `agent status ${ctx.input.agent.status}`)
      : unknown(PolicyField.AGENT_STATUS, 'agent status is not a string'),

  // Membership is one role per tenant, so the first role is the role. If that
  // ever stops being true the detail says so rather than hiding it.
  [PolicyField.PRINCIPAL_ROLE]: (ctx) => {
    const roles = ctx.input.principal.roles;
    if (!Array.isArray(roles) || roles.length === 0) {
      return unknown(PolicyField.PRINCIPAL_ROLE, 'principal holds no role in this tenant');
    }
    const first = roles[0];
    if (typeof first !== 'string') return unknown(PolicyField.PRINCIPAL_ROLE, 'principal role is malformed');
    const extra = roles.length > 1 ? ` (first of ${roles.length} held)` : '';
    return resolved(PolicyField.PRINCIPAL_ROLE, first, `principal role ${first}${extra}`);
  },

  [PolicyField.RUN_ACTION_COUNT]: (ctx) =>
    Number.isSafeInteger(ctx.input.actionCountInRun)
      ? resolved(
          PolicyField.RUN_ACTION_COUNT,
          ctx.input.actionCountInRun,
          `${ctx.input.actionCountInRun} action(s) in run ${ctx.input.runId}`,
        )
      : unknown(PolicyField.RUN_ACTION_COUNT, 'run action count is not a safe integer'),

  [PolicyField.TASK_PURPOSE]: (ctx) =>
    typeof ctx.input.taskPurpose === 'string'
      ? resolved(PolicyField.TASK_PURPOSE, ctx.input.taskPurpose, 'task purpose from the action proposal')
      : unknown(PolicyField.TASK_PURPOSE, 'task purpose is not a string'),

  // -- Proposed arguments: a missing key is `absent` (the validated payload
  // -- definitively omits it); a mistyped value is `unknown` (fail closed). --
  [PolicyField.ARG_AMOUNT_MINOR]: (ctx) => {
    const v = argInt(ctx, 'amount_minor');
    if (v !== undefined) return resolved(PolicyField.ARG_AMOUNT_MINOR, v, `${v} minor units proposed`);
    return 'amount_minor' in ctx.input.arguments
      ? unknown(PolicyField.ARG_AMOUNT_MINOR, 'amount_minor is present but not a safe integer')
      : absent(PolicyField.ARG_AMOUNT_MINOR, "argument 'amount_minor' not present");
  },

  [PolicyField.ARG_CURRENCY]: (ctx) => {
    const v = argString(ctx, 'currency');
    if (v !== undefined) return resolved(PolicyField.ARG_CURRENCY, v, `currency ${v} proposed`);
    return 'currency' in ctx.input.arguments
      ? unknown(PolicyField.ARG_CURRENCY, 'currency is present but not a string')
      : absent(PolicyField.ARG_CURRENCY, "argument 'currency' not present");
  },

  [PolicyField.ARG_VENDOR_ID]: (ctx) => {
    const v = argString(ctx, 'vendor_id');
    if (v !== undefined) return resolved(PolicyField.ARG_VENDOR_ID, v, `vendor ${v} proposed`);
    return 'vendor_id' in ctx.input.arguments
      ? unknown(PolicyField.ARG_VENDOR_ID, 'vendor_id is present but not a string')
      : absent(PolicyField.ARG_VENDOR_ID, "argument 'vendor_id' not present");
  },

  [PolicyField.ARG_BENEFICIARY_REF]: (ctx) => {
    const v = argString(ctx, 'beneficiary_ref');
    if (v !== undefined) return resolved(PolicyField.ARG_BENEFICIARY_REF, v, `beneficiary ${v} proposed`);
    return 'beneficiary_ref' in ctx.input.arguments
      ? unknown(PolicyField.ARG_BENEFICIARY_REF, 'beneficiary_ref is present but not a string')
      : absent(PolicyField.ARG_BENEFICIARY_REF, "argument 'beneficiary_ref' not present");
  },

  [PolicyField.ARG_INVOICE_ID]: (ctx) => {
    const v = argString(ctx, 'invoice_id');
    if (v !== undefined) return resolved(PolicyField.ARG_INVOICE_ID, v, `invoice ${v} referenced`);
    return 'invoice_id' in ctx.input.arguments
      ? unknown(PolicyField.ARG_INVOICE_ID, 'invoice_id is present but not a string')
      : absent(PolicyField.ARG_INVOICE_ID, "argument 'invoice_id' not present");
  },

  [PolicyField.ARG_PURCHASE_ORDER_ID]: (ctx) => {
    const v = argString(ctx, 'purchase_order_id');
    if (v !== undefined) return resolved(PolicyField.ARG_PURCHASE_ORDER_ID, v, `purchase order ${v} referenced`);
    return 'purchase_order_id' in ctx.input.arguments
      ? unknown(PolicyField.ARG_PURCHASE_ORDER_ID, 'purchase_order_id is present but not a string')
      : absent(PolicyField.ARG_PURCHASE_ORDER_ID, "argument 'purchase_order_id' not present");
  },

  [PolicyField.ARG_DESTINATION_REF]: (ctx) => {
    const v = argString(ctx, 'destination_ref');
    if (v !== undefined) return resolved(PolicyField.ARG_DESTINATION_REF, v, `destination ${v} proposed`);
    return 'destination_ref' in ctx.input.arguments
      ? unknown(PolicyField.ARG_DESTINATION_REF, 'destination_ref is present but not a string')
      : absent(PolicyField.ARG_DESTINATION_REF, "argument 'destination_ref' not present");
  },

  [PolicyField.ARG_TARGET_TABLE]: (ctx) => {
    const v = argString(ctx, 'target_table');
    if (v !== undefined) return resolved(PolicyField.ARG_TARGET_TABLE, v, `target table ${v} proposed`);
    return 'target_table' in ctx.input.arguments
      ? unknown(PolicyField.ARG_TARGET_TABLE, 'target_table is present but not a string')
      : absent(PolicyField.ARG_TARGET_TABLE, "argument 'target_table' not present");
  },

  [PolicyField.ARG_RECORD_COUNT]: (ctx) => {
    const v = argInt(ctx, 'record_count');
    if (v !== undefined) return resolved(PolicyField.ARG_RECORD_COUNT, v, `${v} record(s) proposed`);
    return 'record_count' in ctx.input.arguments
      ? unknown(PolicyField.ARG_RECORD_COUNT, 'record_count is present but not a safe integer')
      : absent(PolicyField.ARG_RECORD_COUNT, "argument 'record_count' not present");
  },

  [PolicyField.ARG_DATA_CLASSIFICATION]: (ctx) => {
    const v = argString(ctx, 'data_classification');
    if (v !== undefined) return resolved(PolicyField.ARG_DATA_CLASSIFICATION, v, `classification ${v} proposed`);
    return 'data_classification' in ctx.input.arguments
      ? unknown(PolicyField.ARG_DATA_CLASSIFICATION, 'data_classification is present but not a string')
      : absent(PolicyField.ARG_DATA_CLASSIFICATION, "argument 'data_classification' not present");
  },

  // -- Vendor state: `undefined` means the caller never looked (unknown);
  // -- `null` means it looked and found nothing (absent attributes). --
  [PolicyField.VENDOR_EXISTS]: (ctx) => {
    const v = ctx.input.vendor;
    if (v === undefined) return unknown(PolicyField.VENDOR_EXISTS, 'vendor lookup was not performed');
    if (v === null) return resolved(PolicyField.VENDOR_EXISTS, false, 'no such vendor in this tenant');
    return resolved(PolicyField.VENDOR_EXISTS, true, `vendor ${v.vendorId} found`);
  },

  [PolicyField.VENDOR_STATUS]: (ctx) => {
    const v = ctx.input.vendor;
    if (v === undefined) return unknown(PolicyField.VENDOR_STATUS, 'vendor lookup was not performed');
    if (v === null) return absent(PolicyField.VENDOR_STATUS, 'no such vendor in this tenant');
    return resolved(PolicyField.VENDOR_STATUS, v.status, `vendor status ${v.status}`);
  },

  [PolicyField.VENDOR_ACCOUNT_AGE_DAYS]: (ctx) => {
    const v = ctx.input.vendor;
    if (v === undefined) return unknown(PolicyField.VENDOR_ACCOUNT_AGE_DAYS, 'vendor lookup was not performed');
    if (v === null) return absent(PolicyField.VENDOR_ACCOUNT_AGE_DAYS, 'no such vendor in this tenant');
    if (!Number.isSafeInteger(v.accountAgeDays)) {
      return unknown(PolicyField.VENDOR_ACCOUNT_AGE_DAYS, 'vendor account age is malformed');
    }
    return resolved(PolicyField.VENDOR_ACCOUNT_AGE_DAYS, v.accountAgeDays, `vendor account age ${v.accountAgeDays}d`);
  },

  [PolicyField.VENDOR_BENEFICIARY_MATCHES_VERIFIED]: (ctx) => {
    const v = ctx.input.vendor;
    if (v === undefined) return unknown(PolicyField.VENDOR_BENEFICIARY_MATCHES_VERIFIED, 'vendor lookup was not performed');
    if (v === null) return absent(PolicyField.VENDOR_BENEFICIARY_MATCHES_VERIFIED, 'no such vendor in this tenant');
    const proposed = argString(ctx, 'beneficiary_ref');
    const verified = v.verifiedBeneficiaryRef;
    if (proposed === undefined || typeof verified !== 'string') {
      return unknown(
        PolicyField.VENDOR_BENEFICIARY_MATCHES_VERIFIED,
        'comparison needs a proposed beneficiary and a verified reference',
      );
    }
    const match = proposed === verified;
    return resolved(
      PolicyField.VENDOR_BENEFICIARY_MATCHES_VERIFIED,
      match,
      match ? 'proposed beneficiary matches the verified reference' : 'proposed beneficiary differs from the verified reference',
    );
  },

  [PolicyField.VENDOR_BANKING_CHANGE_HOURS_AGO]: (ctx) => {
    const v = ctx.input.vendor;
    if (v === undefined) return unknown(PolicyField.VENDOR_BANKING_CHANGE_HOURS_AGO, 'vendor lookup was not performed');
    if (v === null) return absent(PolicyField.VENDOR_BANKING_CHANGE_HOURS_AGO, 'no such vendor in this tenant');
    if (v.bankingChangedAt === null) {
      return unknown(PolicyField.VENDOR_BANKING_CHANGE_HOURS_AGO, 'no banking change on record');
    }
    const changedMs = msOf(v.bankingChangedAt);
    if (changedMs === null || ctx.requestedMs === null) {
      return unknown(PolicyField.VENDOR_BANKING_CHANGE_HOURS_AGO, 'banking-change timestamp is unusable');
    }
    const hours = (ctx.requestedMs - changedMs) / 3_600_000;
    return resolved(PolicyField.VENDOR_BANKING_CHANGE_HOURS_AGO, hours, `banking changed ${hours.toFixed(1)}h ago`);
  },

  [PolicyField.VENDOR_BANKING_CHANGE_VERIFIED]: (ctx) => {
    const v = ctx.input.vendor;
    if (v === undefined) return unknown(PolicyField.VENDOR_BANKING_CHANGE_VERIFIED, 'vendor lookup was not performed');
    if (v === null) return absent(PolicyField.VENDOR_BANKING_CHANGE_VERIFIED, 'no such vendor in this tenant');
    if (v.bankingChangedAt === null) {
      return resolved(PolicyField.VENDOR_BANKING_CHANGE_VERIFIED, true, 'no banking change on record; nothing to verify');
    }
    const verified = v.bankingChangeVerifiedAt !== null;
    return resolved(
      PolicyField.VENDOR_BANKING_CHANGE_VERIFIED,
      verified,
      verified ? 'latest banking change was verified out-of-band' : 'latest banking change is unverified',
    );
  },

  [PolicyField.VENDOR_DESTINATION_ALLOWED]: (ctx) => {
    const v = ctx.input.vendor;
    if (v === undefined) return unknown(PolicyField.VENDOR_DESTINATION_ALLOWED, 'vendor lookup was not performed');
    if (v === null) return absent(PolicyField.VENDOR_DESTINATION_ALLOWED, 'no such vendor in this tenant');
    const dest = argString(ctx, 'destination_ref') ?? argString(ctx, 'beneficiary_ref');
    if (dest === undefined) {
      return unknown(PolicyField.VENDOR_DESTINATION_ALLOWED, 'no destination or beneficiary argument to check');
    }
    if (!Array.isArray(v.allowedDestinationRefs)) {
      return unknown(PolicyField.VENDOR_DESTINATION_ALLOWED, 'vendor destination allowlist is malformed');
    }
    const allowed = v.allowedDestinationRefs.includes(dest);
    return resolved(
      PolicyField.VENDOR_DESTINATION_ALLOWED,
      allowed,
      allowed ? `destination ${dest} is allowlisted` : `destination ${dest} is not allowlisted`,
    );
  },

  [PolicyField.VENDOR_DATA_CLASSIFICATION]: (ctx) => {
    const v = ctx.input.vendor;
    if (v === undefined) return unknown(PolicyField.VENDOR_DATA_CLASSIFICATION, 'vendor lookup was not performed');
    if (v === null) return absent(PolicyField.VENDOR_DATA_CLASSIFICATION, 'no such vendor in this tenant');
    if (typeof v.dataClassification !== 'string') {
      return unknown(PolicyField.VENDOR_DATA_CLASSIFICATION, 'vendor data classification is malformed');
    }
    return resolved(PolicyField.VENDOR_DATA_CLASSIFICATION, v.dataClassification, `vendor data is ${v.dataClassification}`);
  },

  // -- Invoice match --
  [PolicyField.INVOICE_EXISTS]: (ctx) => {
    const i = ctx.input.invoice;
    if (i === undefined) return unknown(PolicyField.INVOICE_EXISTS, 'invoice lookup was not performed');
    if (i === null) return resolved(PolicyField.INVOICE_EXISTS, false, 'no such invoice in this tenant');
    return resolved(PolicyField.INVOICE_EXISTS, true, `invoice ${i.invoiceId} found`);
  },

  [PolicyField.INVOICE_VENDOR_MATCHES]: (ctx) => {
    const i = ctx.input.invoice;
    if (i === undefined) return unknown(PolicyField.INVOICE_VENDOR_MATCHES, 'invoice lookup was not performed');
    if (i === null) return absent(PolicyField.INVOICE_VENDOR_MATCHES, 'no such invoice in this tenant');
    const vendorId = argString(ctx, 'vendor_id');
    if (vendorId === undefined) {
      return unknown(PolicyField.INVOICE_VENDOR_MATCHES, "argument 'vendor_id' not present for comparison");
    }
    const match = i.vendorId === vendorId;
    return resolved(
      PolicyField.INVOICE_VENDOR_MATCHES,
      match,
      match ? 'invoice belongs to the proposed vendor' : 'invoice belongs to a different vendor',
    );
  },

  [PolicyField.INVOICE_AMOUNT_MATCHES_ARGUMENT]: (ctx) => {
    const i = ctx.input.invoice;
    if (i === undefined) return unknown(PolicyField.INVOICE_AMOUNT_MATCHES_ARGUMENT, 'invoice lookup was not performed');
    if (i === null) return absent(PolicyField.INVOICE_AMOUNT_MATCHES_ARGUMENT, 'no such invoice in this tenant');
    const amount = argInt(ctx, 'amount_minor');
    if (amount === undefined) {
      return unknown(PolicyField.INVOICE_AMOUNT_MATCHES_ARGUMENT, "argument 'amount_minor' not present for comparison");
    }
    const match = i.amountMinor === amount;
    return resolved(
      PolicyField.INVOICE_AMOUNT_MATCHES_ARGUMENT,
      match,
      match ? 'proposed amount equals the invoice amount' : 'proposed amount differs from the invoice amount',
    );
  },

  [PolicyField.INVOICE_CURRENCY_MATCHES_ARGUMENT]: (ctx) => {
    const i = ctx.input.invoice;
    if (i === undefined) return unknown(PolicyField.INVOICE_CURRENCY_MATCHES_ARGUMENT, 'invoice lookup was not performed');
    if (i === null) return absent(PolicyField.INVOICE_CURRENCY_MATCHES_ARGUMENT, 'no such invoice in this tenant');
    const currency = argString(ctx, 'currency');
    if (currency === undefined) {
      return unknown(PolicyField.INVOICE_CURRENCY_MATCHES_ARGUMENT, "argument 'currency' not present for comparison");
    }
    const match = i.currency === currency;
    return resolved(
      PolicyField.INVOICE_CURRENCY_MATCHES_ARGUMENT,
      match,
      match ? 'proposed currency equals the invoice currency' : 'proposed currency differs from the invoice currency',
    );
  },

  // -- Purchase-order match --
  [PolicyField.PURCHASE_ORDER_EXISTS]: (ctx) => {
    const p = ctx.input.purchaseOrder;
    if (p === undefined) return unknown(PolicyField.PURCHASE_ORDER_EXISTS, 'purchase-order lookup was not performed');
    if (p === null) return resolved(PolicyField.PURCHASE_ORDER_EXISTS, false, 'no such purchase order in this tenant');
    return resolved(PolicyField.PURCHASE_ORDER_EXISTS, true, `purchase order ${p.purchaseOrderId} found`);
  },

  [PolicyField.PURCHASE_ORDER_MATCHED]: (ctx) => {
    const p = ctx.input.purchaseOrder;
    if (p === undefined) return unknown(PolicyField.PURCHASE_ORDER_MATCHED, 'purchase-order lookup was not performed');
    if (p === null) return absent(PolicyField.PURCHASE_ORDER_MATCHED, 'no such purchase order in this tenant');
    // The payment tools carry no purchase_order_id argument; the reference
    // normally comes from the authoritative invoice the action cites.
    const invoice = ctx.input.invoice;
    const poId = argString(ctx, 'purchase_order_id') ?? (typeof invoice === 'object' && invoice !== null ? invoice.purchaseOrderId : undefined);
    const vendorId = argString(ctx, 'vendor_id') ?? (typeof invoice === 'object' && invoice !== null ? invoice.vendorId : undefined);
    if (typeof poId !== 'string') {
      return unknown(PolicyField.PURCHASE_ORDER_MATCHED, 'no purchase order reference to match against');
    }
    const match = p.purchaseOrderId === poId && (vendorId === undefined || p.vendorId === vendorId);
    return resolved(
      PolicyField.PURCHASE_ORDER_MATCHED,
      match,
      match ? 'purchase order matches id and vendor' : 'purchase order id or vendor differs',
    );
  },

  [PolicyField.PURCHASE_ORDER_AMOUNT_COVERS]: (ctx) => {
    const p = ctx.input.purchaseOrder;
    if (p === undefined) return unknown(PolicyField.PURCHASE_ORDER_AMOUNT_COVERS, 'purchase-order lookup was not performed');
    if (p === null) return absent(PolicyField.PURCHASE_ORDER_AMOUNT_COVERS, 'no such purchase order in this tenant');
    const amount = argInt(ctx, 'amount_minor');
    if (amount === undefined) {
      return unknown(PolicyField.PURCHASE_ORDER_AMOUNT_COVERS, "argument 'amount_minor' not present for comparison");
    }
    const covers = p.amountMinor >= amount;
    return resolved(
      PolicyField.PURCHASE_ORDER_AMOUNT_COVERS,
      covers,
      covers ? 'purchase order covers the proposed amount' : 'proposed amount exceeds the purchase order',
    );
  },

  [PolicyField.PURCHASE_ORDER_VENDOR_MATCHES]: (ctx) => {
    const p = ctx.input.purchaseOrder;
    if (p === undefined) return unknown(PolicyField.PURCHASE_ORDER_VENDOR_MATCHES, 'purchase-order lookup was not performed');
    if (p === null) return absent(PolicyField.PURCHASE_ORDER_VENDOR_MATCHES, 'no such purchase order in this tenant');
    const invoice = ctx.input.invoice;
    const vendorId =
      argString(ctx, 'vendor_id') ?? (typeof invoice === 'object' && invoice !== null ? invoice.vendorId : undefined);
    if (typeof vendorId !== 'string') {
      return unknown(PolicyField.PURCHASE_ORDER_VENDOR_MATCHES, 'no vendor reference to match against');
    }
    const match = p.vendorId === vendorId;
    return resolved(
      PolicyField.PURCHASE_ORDER_VENDOR_MATCHES,
      match,
      match ? 'purchase order belongs to the proposed vendor' : 'purchase order belongs to a different vendor',
    );
  },

  // -- Evidence --
  [PolicyField.EVIDENCE_HAS_KIND]: (ctx) => {
    const refs = ctx.input.evidenceRefs;
    if (!Array.isArray(refs)) return unknown(PolicyField.EVIDENCE_HAS_KIND, 'evidence refs are malformed');
    const kinds = [...new Set(refs.map((r) => r?.kind).filter((k): k is string => typeof k === 'string'))].sort();
    return resolved(
      PolicyField.EVIDENCE_HAS_KIND,
      kinds.join(','),
      kinds.length > 0 ? `evidence kinds: ${kinds.join(', ')}` : 'no evidence refs',
      kinds,
    );
  },

  [PolicyField.EVIDENCE_COUNT]: (ctx) => {
    const refs = ctx.input.evidenceRefs;
    if (!Array.isArray(refs)) return unknown(PolicyField.EVIDENCE_COUNT, 'evidence refs are malformed');
    return resolved(PolicyField.EVIDENCE_COUNT, refs.length, `${refs.length} evidence ref(s)`);
  },

  [PolicyField.EVIDENCE_ALL_UNTRUSTED_LABELLED]: (ctx) => {
    const refs = ctx.input.evidenceRefs;
    if (!Array.isArray(refs)) {
      return unknown(PolicyField.EVIDENCE_ALL_UNTRUSTED_LABELLED, 'evidence refs are malformed');
    }
    const labelled = refs.every((r) => r !== null && typeof r === 'object' && typeof r.kind === 'string' && typeof r.trusted === 'boolean');
    return resolved(
      PolicyField.EVIDENCE_ALL_UNTRUSTED_LABELLED,
      labelled,
      labelled ? 'every evidence ref carries explicit trust labelling' : 'an evidence ref is missing trust labelling',
    );
  },

  // -- Connector --
  [PolicyField.CONNECTOR_EXISTS]: (ctx) => {
    const c = ctx.input.connector;
    if (c === undefined) return unknown(PolicyField.CONNECTOR_EXISTS, 'connector lookup was not performed');
    if (c === null) return resolved(PolicyField.CONNECTOR_EXISTS, false, 'no such connector in this tenant');
    return resolved(PolicyField.CONNECTOR_EXISTS, true, `connector ${c.connectorId} found`);
  },

  [PolicyField.CONNECTOR_STATUS]: (ctx) => {
    const c = ctx.input.connector;
    if (c === undefined) return unknown(PolicyField.CONNECTOR_STATUS, 'connector lookup was not performed');
    if (c === null) return absent(PolicyField.CONNECTOR_STATUS, 'no such connector in this tenant');
    return resolved(PolicyField.CONNECTOR_STATUS, c.status, `connector status ${c.status}`);
  },

  [PolicyField.CONNECTOR_SIMULATED]: (ctx) => {
    const c = ctx.input.connector;
    if (c === undefined) return unknown(PolicyField.CONNECTOR_SIMULATED, 'connector lookup was not performed');
    if (c === null) return absent(PolicyField.CONNECTOR_SIMULATED, 'no such connector in this tenant');
    return resolved(
      PolicyField.CONNECTOR_SIMULATED,
      c.simulated,
      c.simulated ? 'connector is the labelled simulator' : 'connector is a live external system',
    );
  },

  [PolicyField.CONNECTOR_TOOL_ALLOWED]: (ctx) => {
    const c = ctx.input.connector;
    if (c === undefined) return unknown(PolicyField.CONNECTOR_TOOL_ALLOWED, 'connector lookup was not performed');
    if (c === null) return absent(PolicyField.CONNECTOR_TOOL_ALLOWED, 'no such connector in this tenant');
    if (!Array.isArray(c.allowedTools)) {
      return unknown(PolicyField.CONNECTOR_TOOL_ALLOWED, 'connector tool allowlist is malformed');
    }
    const allowed = c.allowedTools.includes(ctx.input.toolName);
    return resolved(
      PolicyField.CONNECTOR_TOOL_ALLOWED,
      allowed,
      allowed ? `connector permits ${ctx.input.toolName}` : `connector does not permit ${ctx.input.toolName}`,
    );
  },

  // -- Aggregate controls --
  [PolicyField.BUDGET_SPEND_MINOR]: (ctx) =>
    Number.isSafeInteger(ctx.input.budgetSpendMinor)
      ? resolved(PolicyField.BUDGET_SPEND_MINOR, ctx.input.budgetSpendMinor, `${ctx.input.budgetSpendMinor} minor units spent in window`)
      : unknown(PolicyField.BUDGET_SPEND_MINOR, 'budget spend is not a safe integer'),

  [PolicyField.VELOCITY_COUNT]: (ctx) =>
    Number.isSafeInteger(ctx.input.velocityCount)
      ? resolved(PolicyField.VELOCITY_COUNT, ctx.input.velocityCount, `${ctx.input.velocityCount} action(s) in velocity window`)
      : unknown(PolicyField.VELOCITY_COUNT, 'velocity count is not a safe integer'),

  [PolicyField.TIME_HOUR_UTC]: (ctx) => {
    if (ctx.requestedMs === null) return unknown(PolicyField.TIME_HOUR_UTC, 'request timestamp is unusable');
    const hour = new Date(ctx.requestedMs).getUTCHours();
    return resolved(PolicyField.TIME_HOUR_UTC, hour, `request hour ${hour} UTC`);
  },

  [PolicyField.TIME_DAY_OF_WEEK_UTC]: (ctx) => {
    if (ctx.requestedMs === null) return unknown(PolicyField.TIME_DAY_OF_WEEK_UTC, 'request timestamp is unusable');
    const day = new Date(ctx.requestedMs).getUTCDay();
    return resolved(PolicyField.TIME_DAY_OF_WEEK_UTC, day, `request day ${day} UTC (0 = Sunday)`);
  },

  // -- Advisory model signals: may escalate, may never allow. --
  [PolicyField.MODEL_ENABLED]: (ctx) => {
    const enabled = ctx.input.riskHints !== null || ctx.input.requiredModelSignalUnavailable === true;
    return resolved(
      PolicyField.MODEL_ENABLED,
      enabled,
      enabled ? 'model advisory path is enabled' : 'model advisory path is disabled',
    );
  },

  [PolicyField.MODEL_SIGNAL_PRESENT]: (ctx) => {
    const hints = ctx.input.riskHints;
    if (hints === null) return unknown(PolicyField.MODEL_SIGNAL_PRESENT, 'no model signal was produced');
    const kinds = [...new Set(hints.instructionInjectionIndicators.map((i) => i.kind))].sort();
    return resolved(
      PolicyField.MODEL_SIGNAL_PRESENT,
      kinds.join(','),
      kinds.length > 0 ? `advisory signals: ${kinds.join(', ')}` : 'model produced no advisory signals',
      kinds,
    );
  },

  [PolicyField.MODEL_MAX_INJECTION_CONFIDENCE]: (ctx) => {
    const hints = ctx.input.riskHints;
    if (hints === null) return unknown(PolicyField.MODEL_MAX_INJECTION_CONFIDENCE, 'no model signal was produced');
    let max = 0;
    for (const i of hints.instructionInjectionIndicators) {
      if (typeof i.confidence === 'number' && Number.isFinite(i.confidence) && i.confidence > max) max = i.confidence;
    }
    return resolved(PolicyField.MODEL_MAX_INJECTION_CONFIDENCE, max, `highest advisory confidence ${max}`);
  },

  [PolicyField.MODEL_MISSING_EVIDENCE_COUNT]: (ctx) => {
    const hints = ctx.input.riskHints;
    if (hints === null) return unknown(PolicyField.MODEL_MISSING_EVIDENCE_COUNT, 'no model signal was produced');
    const n = Array.isArray(hints.missingEvidence) ? hints.missingEvidence.length : 0;
    return resolved(PolicyField.MODEL_MISSING_EVIDENCE_COUNT, n, `model flags ${n} missing evidence item(s)`);
  },
};

export function resolveFieldMap(input: PolicyEvaluationInput): ReadonlyMap<PolicyField, InternalResolved> {
  const requestedMs = input.requestedAt instanceof Date ? msOf(input.requestedAt) : null;
  const ctx: ResolverContext = { input, requestedMs };
  const map = new Map<PolicyField, InternalResolved>();
  for (const field of POLICY_FIELDS) {
    map.set(field, RESOLVERS[field](ctx));
  }
  return map;
}

/**
 * Every field the engine knows how to resolve, with its resolved value. Used
 * by the decision drawer and the Replay Lab to explain a decision.
 */
export function resolveFields(input: PolicyEvaluationInput): ResolvedField[] {
  const out: ResolvedField[] = [];
  for (const r of resolveFieldMap(input).values()) {
    out.push({ field: r.field, resolved: r.resolved, value: r.value, detail: r.detail });
  }
  return out;
}
