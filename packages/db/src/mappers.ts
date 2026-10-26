/**
 * Row → domain-record mappers. The single boundary where database shapes
 * become domain shapes: bigint money becomes safe numbers (unsafe magnitudes
 * are refused, never truncated), JSONB becomes typed records, and enum text
 * becomes domain unions (the CHECK constraints already proved the values).
 */
import { MoneyError } from '@permitzero/domain';
import type {
  ActionRecord,
  AgentRecord,
  ApprovalRecord,
  AuditEventRecord,
  ConnectorRecord,
  Decision,
  Environment,
  EvidenceRef,
  InvoiceRecord,
  PolicyRevisionStatus,
  PurchaseOrderRecord,
  RiskSignal,
  VendorRecord,
} from '@permitzero/domain';
import type {
  ConnectorDispatchRecord,
  ConnectorLedgerEntry,
  ConnectorReceipt,
  PersistedExecution,
  PersistedPermit,
} from '@permitzero/broker';
import type {
  ActionRow,
  AgentRow,
  ApprovalRow,
  AuditEventRow,
  ConnectorDispatchRow,
  ConnectorLedgerRow,
  ConnectorRow,
  ExecutionRow,
  InvoiceRow,
  PermitRow,
  PolicyRevisionRow,
  PurchaseOrderRow,
  VendorRow,
} from './schema.js';

/** Refuse unsafe magnitudes at the boundary instead of silently truncating. */
export function assertSafeMinor(value: bigint, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new MoneyError(`${what} of ${value} minor units exceeds the safe integer range.`);
  }
  return n;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function toActionRecord(row: ActionRow): ActionRecord {
  return {
    actionId: row.actionId,
    tenantId: row.tenantId,
    agentId: row.agentId,
    runId: row.runId,
    toolName: row.toolName,
    operation: row.operation,
    taskPurpose: row.taskPurpose,
    argumentsRedacted: asRecord(row.argumentsJsonRedacted),
    argumentsHash: row.argumentsHash,
    hashVersion: row.hashVersion,
    evidenceRefs: asArray<EvidenceRef>(row.evidenceRefsJson),
    idempotencyKey: row.idempotencyKey,
    state: row.state as ActionRecord['state'],
    decision: row.decision as Decision | null,
    decisionReasonCodes: asStringArray(row.decisionReasonCodesJson),
    policyRevisionId: row.policyRevisionId,
    riskSignals: asArray<RiskSignal>(row.riskSignalsJson),
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    version: row.version,
    environment: row.environment as Environment,
    requiredApprovals: row.requiredApprovals,
    traceId: row.traceId,
    createdByActorId: row.createdByActorId,
    createdByActorType: row.createdByActorType as ActionRecord['createdByActorType'],
  };
}

export function toAgentRecord(row: AgentRow): AgentRecord {
  return {
    agentId: row.agentId,
    tenantId: row.tenantId,
    name: row.name,
    framework: row.framework,
    environment: row.environment as Environment,
    status: row.status as AgentRecord['status'],
    credentialId: row.credentialId,
    credentialExpiresAt: row.credentialExpiresAt,
    allowedTools: asArray<AgentRecord['allowedTools'][number]>(row.allowedToolsJson),
    revokedAt: row.revokedAt,
  };
}

export function toConnectorRecord(row: ConnectorRow): ConnectorRecord {
  return {
    connectorId: row.connectorId,
    tenantId: row.tenantId,
    name: row.name,
    type: row.type,
    environment: row.environment as Environment,
    status: row.status as ConnectorRecord['status'],
    allowedTools: asStringArray(row.allowedToolsJson),
    credentialRef: row.credentialRef,
    lastHealthCheckAt: row.lastHealthCheckAt,
    simulated: row.simulated,
  };
}

export function toVendorRecord(row: VendorRow): VendorRecord {
  return {
    vendorId: row.vendorId,
    tenantId: row.tenantId,
    name: row.name,
    status: row.status as VendorRecord['status'],
    verifiedBeneficiaryRef: row.verifiedBeneficiaryRef,
    verifiedAt: row.verifiedAt,
    bankingChangedAt: row.bankingChangedAt,
    bankingChangeVerifiedAt: row.bankingChangeVerifiedAt,
    pendingBeneficiaryRef: row.pendingBeneficiaryRef,
    allowedDestinationRefs: asStringArray(row.allowedDestinationRefsJson),
    accountAgeDays: row.accountAgeDays,
    dataClassification: row.dataClassification,
  };
}

export function toInvoiceRecord(row: InvoiceRow): InvoiceRecord {
  return {
    invoiceId: row.invoiceId,
    tenantId: row.tenantId,
    vendorId: row.vendorId,
    amountMinor: assertSafeMinor(row.amountMinor, `invoice ${row.invoiceId}`),
    currency: row.currency,
    purchaseOrderId: row.purchaseOrderId,
    status: row.status as InvoiceRecord['status'],
    documentText: row.documentText,
    // Invoices are always untrusted evidence from the engine's perspective.
    untrusted: true,
  };
}

export function toPurchaseOrderRecord(row: PurchaseOrderRow): PurchaseOrderRecord {
  return {
    purchaseOrderId: row.purchaseOrderId,
    tenantId: row.tenantId,
    vendorId: row.vendorId,
    amountMinor: assertSafeMinor(row.amountMinor, `purchase order ${row.purchaseOrderId}`),
    currency: row.currency,
    status: row.status as PurchaseOrderRecord['status'],
    matchedInvoiceIds: asStringArray(row.matchedInvoiceIdsJson),
  };
}

export function toApprovalRecord(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approvalId,
    tenantId: row.tenantId,
    actionId: row.actionId,
    actionHash: row.actionHash,
    policyRevisionId: row.policyRevisionId,
    approverUserId: row.approverUserId,
    decision: row.decision,
    reasonCode: row.reasonCode,
    reasonTextRedacted: row.reasonTextRedacted,
    approvedAt: row.approvedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    mfaContextRef: row.mfaContextRef,
  };
}

export function toAuditEventRecord(row: AuditEventRow): AuditEventRecord {
  return {
    eventId: row.eventId,
    tenantId: row.tenantId,
    sequence: Number(row.sequence),
    eventType: row.eventType,
    actionId: row.actionId,
    runId: row.runId,
    actorType: row.actorType,
    actorId: row.actorId,
    policyRevisionId: row.policyRevisionId,
    payloadRedacted: asRecord(row.payloadRedactedJson),
    eventHash: row.eventHash,
    previousHash: row.previousHash,
    hashVersion: row.hashVersion,
    traceId: row.traceId,
    eventTime: row.eventTime,
  };
}

export function toPersistedPermit(row: PermitRow): PersistedPermit {
  if (!row.tokenHash) throw new Error(`permit ${row.permitId} has no token hash`);
  return {
    permitId: row.permitId,
    tenantId: row.tenantId,
    actionId: row.actionId,
    actionHash: row.actionHash,
    policyRevisionId: row.policyRevisionId,
    audienceTool: row.audienceTool,
    nonceHash: row.nonceHash,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    revokedAt: row.revokedAt,
    signatureKeyId: row.signatureKeyId,
    tokenHash: row.tokenHash as string,
    revokeReason: row.revocationReason,
    version: row.version,
  };
}

function toConnectorReceipt(value: unknown): ConnectorReceipt | null {
  const r = asRecord(value);
  if (typeof r['externalReference'] !== 'string') return null;
  const completedAt = r['completedAt'];
  return {
    externalReference: r['externalReference'] as string,
    receiptHash: typeof r['receiptHash'] === 'string' ? (r['receiptHash'] as string) : '',
    amountMinor: typeof r['amountMinor'] === 'number' ? (r['amountMinor'] as number) : 0,
    currency: typeof r['currency'] === 'string' ? (r['currency'] as string) : 'XXX',
    beneficiaryRef: typeof r['beneficiaryRef'] === 'string' ? (r['beneficiaryRef'] as string) : '',
    completedAt: completedAt instanceof Date ? completedAt : new Date(completedAt as string),
    // This connector only ever issues simulated receipts.
    simulated: true,
  };
}

export function toPersistedExecution(row: ExecutionRow): PersistedExecution {
  return {
    executionId: row.executionId,
    tenantId: row.tenantId,
    actionId: row.actionId,
    connectorId: row.connectorId,
    attemptNumber: row.attemptNumber,
    connectorIdempotencyKey: row.connectorIdempotencyKey,
    state: row.state as PersistedExecution['state'],
    dispatchStartedAt: row.dispatchStartedAt,
    resultReceivedAt: row.resultReceivedAt,
    externalReference: row.externalReference,
    receiptHash: row.receiptHash,
    errorClass: row.errorClass,
    retryAfterAt: row.retryAfterAt,
    permitId: row.permitId,
    permitNonceHash: row.permitNonceHash,
    actorId: row.actorId,
    traceId: row.traceId,
    receipt: row.receiptJson ? toConnectorReceipt(row.receiptJson) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toConnectorLedgerEntry(row: ConnectorLedgerRow): ConnectorLedgerEntry {
  return {
    tenantId: row.tenantId,
    connectorId: row.connectorId,
    connectorIdempotencyKey: row.connectorIdempotencyKey,
    operation: row.operation,
    externalReference: row.externalReference,
    receipt: toConnectorReceipt(row.receiptJson) ?? {
      externalReference: row.externalReference,
      receiptHash: row.receiptHash,
      amountMinor: 0,
      currency: 'XXX',
      beneficiaryRef: '',
      completedAt: row.createdAt,
      simulated: true,
    },
    detailRedacted: asRecord(row.detailJsonRedacted),
    actionId: row.actionId,
    executionId: row.executionId,
    recordedAt: row.createdAt,
  };
}

export function toConnectorDispatchRecord(row: ConnectorDispatchRow): ConnectorDispatchRecord {
  return {
    tenantId: row.tenantId,
    connectorIdempotencyKey: row.connectorIdempotencyKey,
    operation: row.operation,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    outcome: row.outcome,
  };
}

export function policyRevisionStatusOf(row: PolicyRevisionRow): PolicyRevisionStatus {
  return row.status as PolicyRevisionStatus;
}
