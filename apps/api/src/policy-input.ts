/**
 * Policy evaluation inputs: authoritative lookups plus revision pinning.
 *
 * Pinning rule: intake evaluates against the tenant's single ACTIVE policy's
 * published head, pinned by revision id. Zero or several candidates fail
 * closed (INDETERMINATE) rather than guessing — a tenant that cannot name
 * its policy cannot authorize actions.
 */
import { EnforcementMode } from '@permitzero/domain';
import type {
  AgentRecord,
  Environment,
  EvidenceRef,
  PolicyEvaluationInput,
  Principal,
  RiskHints,
} from '@permitzero/domain';
import { policyDocumentSchema } from '@permitzero/schemas';
import { ruleReferencesModel } from '@permitzero/policy';
import type { PinnedPolicyRevision } from '@permitzero/policy';
import {
  countActionsInRun,
  countAgentActionsSince,
  findConnectorForTool,
  getEnforcementMode,
  getInvoice,
  getPurchaseOrder,
  getVendor,
  getPublishedRevision,
  listPolicies,
  sumSucceededPaymentsSince,
  toAgentRecord,
  toConnectorRecord,
  toInvoiceRecord,
  toPurchaseOrderRecord,
  toVendorRecord,
} from '@permitzero/db';
import type { AgentRow, DbExecutor } from '@permitzero/db';

export const VELOCITY_WINDOW_MS = 3_600_000;
export const BUDGET_WINDOW_MS = 86_400_000;

export type PinFailureReason =
  | 'NO_ACTIVE_POLICY'
  | 'NO_PUBLISHED_REVISION'
  | 'AMBIGUOUS_POLICY'
  | 'MALFORMED_DOCUMENT';

export type PinResult =
  | { ok: true; pin: PinnedPolicyRevision }
  | { ok: false; reason: PinFailureReason; detail: string };

export async function pinPublishedPolicy(ex: DbExecutor, tenantId: string): Promise<PinResult> {
  const active = (await listPolicies(ex, tenantId)).filter((p) => p.status === 'ACTIVE');
  if (active.length === 0) {
    return { ok: false, reason: 'NO_ACTIVE_POLICY', detail: 'This tenant has no active policy.' };
  }
  const withHead = active.filter((p) => p.publishedRevisionId !== null);
  if (withHead.length === 0) {
    return {
      ok: false,
      reason: 'NO_PUBLISHED_REVISION',
      detail: 'The active policy has no published revision yet.',
    };
  }
  if (withHead.length > 1) {
    return {
      ok: false,
      reason: 'AMBIGUOUS_POLICY',
      detail: 'Several active policies have published heads; the tenant cannot name one.',
    };
  }
  const policy = withHead[0];
  if (!policy) {
    return { ok: false, reason: 'NO_ACTIVE_POLICY', detail: 'This tenant has no active policy.' };
  }
  const revision = await getPublishedRevision(ex, tenantId, policy.policyId);
  if (!revision) {
    return {
      ok: false,
      reason: 'NO_PUBLISHED_REVISION',
      detail: 'The published head could not be read.',
    };
  }
  const parsed = policyDocumentSchema.safeParse(revision.policyJson);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'MALFORMED_DOCUMENT',
      detail: 'The published policy document failed validation.',
    };
  }
  return {
    ok: true,
    pin: {
      revisionId: revision.revisionId,
      policyId: policy.policyId,
      tenantId,
      revisionNumber: revision.revisionNumber,
      document: parsed.data,
      policyHash: revision.policyHash,
      status: revision.status,
      publishedAt: revision.publishedAt,
    },
  };
}

/** True when any enabled rule could consult an advisory model signal. */
export function revisionUsesModel(pin: PinnedPolicyRevision): boolean {
  return pin.document.rules.some((r) => r.enabled !== false && ruleReferencesModel(r.when));
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface PolicyInputArgs {
  tenantId: string;
  environment: Environment;
  agent: AgentRecord;
  principal: Principal;
  toolName: string;
  operation: string;
  taskPurpose: string;
  args: Record<string, unknown>;
  evidenceRefs: readonly EvidenceRef[];
  requestedAt: Date;
  runId: string;
  riskHints: RiskHints | null;
  requiredModelSignalUnavailable: boolean;
}

export async function buildPolicyInput(ex: DbExecutor, a: PolicyInputArgs): Promise<PolicyEvaluationInput> {
  const vendorId = stringArg(a.args, 'vendor_id');
  const invoiceId = stringArg(a.args, 'invoice_id');

  const [vendorRow, invoiceRow, connectorRow, modeRow, runCount, velocity, spend] = await Promise.all([
    vendorId ? getVendor(ex, a.tenantId, vendorId) : Promise.resolve(undefined),
    invoiceId ? getInvoice(ex, a.tenantId, invoiceId) : Promise.resolve(undefined),
    findConnectorForTool(ex, a.tenantId, a.toolName),
    getEnforcementMode(ex, a.tenantId),
    countActionsInRun(ex, a.tenantId, a.runId),
    countAgentActionsSince(ex, a.tenantId, a.agent.agentId, new Date(a.requestedAt.getTime() - VELOCITY_WINDOW_MS)),
    sumSucceededPaymentsSince(ex, a.tenantId, new Date(a.requestedAt.getTime() - BUDGET_WINDOW_MS)),
  ]);

  // Payment tools carry no purchase_order_id; the reference comes from the
  // authoritative invoice the action cites (fields.ts documents the same).
  const purchaseOrderId = stringArg(a.args, 'purchase_order_id') ?? invoiceRow?.purchaseOrderId ?? undefined;
  const poRow = purchaseOrderId ? await getPurchaseOrder(ex, a.tenantId, purchaseOrderId) : undefined;

  return {
    tenantId: a.tenantId,
    environment: a.environment,
    agent: a.agent,
    principal: a.principal,
    toolName: a.toolName,
    operation: a.operation,
    taskPurpose: a.taskPurpose,
    arguments: a.args,
    evidenceRefs: a.evidenceRefs,
    requestedAt: a.requestedAt,
    runId: a.runId,
    actionCountInRun: runCount,
    // Looked up and missing (null) vs never looked up (undefined): the
    // engine treats the two differently, so preserve the distinction.
    vendor: vendorId ? (vendorRow ? toVendorRecord(vendorRow) : null) : undefined,
    invoice: invoiceId ? (invoiceRow ? toInvoiceRecord(invoiceRow) : null) : undefined,
    purchaseOrder: purchaseOrderId ? (poRow ? toPurchaseOrderRecord(poRow) : null) : undefined,
    connector: connectorRow ? toConnectorRecord(connectorRow) : null,
    riskHints: a.riskHints,
    requiredModelSignalUnavailable: a.requiredModelSignalUnavailable,
    budgetSpendMinor: spend,
    velocityCount: velocity,
    velocityWindowStartedAt: new Date(a.requestedAt.getTime() - VELOCITY_WINDOW_MS),
    enforcementMode: modeRow?.mode ?? EnforcementMode.ENFORCED,
    policyStoreAvailable: true,
  };
}

export function agentRecordFromRow(row: AgentRow): AgentRecord {
  return toAgentRecord(row);
}
