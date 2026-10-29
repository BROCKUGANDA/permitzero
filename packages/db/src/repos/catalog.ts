/**
 * Catalog repositories: connectors, the simulated connector's business data
 * (vendors, invoices, purchase orders), its ledger and dispatch markers,
 * enforcement modes and model-evaluation records.
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { newId } from '@permitzero/domain';
import type { ActorType, EnforcementMode, Environment, VendorStatus } from '@permitzero/domain';
import type { DbExecutor } from '../client.js';
import { currentKey, deriveKey, encryptNullableColumn, readColumn, verificationKeys } from '../crypto.js';
import {
  connectorDispatches,
  connectorLedger,
  connectors,
  enforcementModes,
  invoices,
  modelEvaluations,
  purchaseOrders,
  vendors,
} from '../schema.js';
import type {
  ConnectorDispatchRow,
  ConnectorLedgerRow,
  ConnectorRow,
  EnforcementModeRow,
  InvoiceRow,
  ModelEvaluationRow,
  PurchaseOrderRow,
  VendorRow,
} from '../schema.js';

async function first<T>(rows: Promise<T[]>): Promise<T | null> {
  const [row] = await rows;
  return row ?? null;
}

// -- Connectors --------------------------------------------------------------

export interface CreateConnectorInput {
  connectorId: string;
  tenantId: string;
  name: string;
  type: string;
  environment: Environment;
  status?: ConnectorRow['status'];
  allowedTools: readonly string[];
  credentialRef: string;
  simulated?: boolean;
}

export async function createConnector(ex: DbExecutor, input: CreateConnectorInput): Promise<ConnectorRow> {
  const [row] = await ex
    .insert(connectors)
    .values({
      connectorId: input.connectorId,
      tenantId: input.tenantId,
      name: input.name,
      type: input.type,
      environment: input.environment,
      status: input.status ?? 'ENABLED',
      allowedToolsJson: [...input.allowedTools],
      credentialRef: input.credentialRef,
      simulated: input.simulated ?? false,
    })
    .returning();
  if (!row) throw new Error('connector insert returned no row');
  return row;
}

export async function getConnector(
  ex: DbExecutor,
  tenantId: string,
  connectorId: string,
): Promise<ConnectorRow | null> {
  return first(
    ex
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenantId, tenantId), eq(connectors.connectorId, connectorId)))
      .limit(1),
  );
}

export async function listConnectors(ex: DbExecutor, tenantId: string): Promise<ConnectorRow[]> {
  return ex.select().from(connectors).where(eq(connectors.tenantId, tenantId));
}

/** First connector in this tenant whose allowlist includes the tool. */
export async function findConnectorForTool(
  ex: DbExecutor,
  tenantId: string,
  toolName: string,
): Promise<ConnectorRow | null> {
  const rows = await listConnectors(ex, tenantId);
  for (const row of rows) {
    const tools = Array.isArray(row.allowedToolsJson) ? row.allowedToolsJson : [];
    if (tools.includes(toolName)) return row;
  }
  return null;
}

export async function updateConnectorHealth(
  ex: DbExecutor,
  tenantId: string,
  connectorId: string,
  at: Date,
): Promise<void> {
  await ex
    .update(connectors)
    .set({ lastHealthCheckAt: at })
    .where(and(eq(connectors.tenantId, tenantId), eq(connectors.connectorId, connectorId)));
}

export async function setConnectorStatus(
  ex: DbExecutor,
  tenantId: string,
  connectorId: string,
  status: ConnectorRow['status'],
): Promise<void> {
  await ex
    .update(connectors)
    .set({ status })
    .where(and(eq(connectors.tenantId, tenantId), eq(connectors.connectorId, connectorId)));
}

// -- Vendors / invoices / purchase orders ------------------------------------

export async function getVendor(ex: DbExecutor, tenantId: string, vendorId: string): Promise<VendorRow | null> {
  return first(
    ex
      .select()
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), eq(vendors.vendorId, vendorId)))
      .limit(1),
  );
}

export async function listVendors(ex: DbExecutor, tenantId: string, limit: number): Promise<VendorRow[]> {
  return ex.select().from(vendors).where(eq(vendors.tenantId, tenantId)).limit(limit);
}

export async function upsertVendor(
  ex: DbExecutor,
  input: {
    vendorId: string;
    tenantId: string;
    name: string;
    status: VendorStatus;
    verifiedBeneficiaryRef?: string | null;
    verifiedAt?: Date | null;
    bankingChangedAt?: Date | null;
    bankingChangeVerifiedAt?: Date | null;
    pendingBeneficiaryRef?: string | null;
    allowedDestinationRefs: readonly string[];
    accountAgeDays: number;
    dataClassification: string;
  },
): Promise<VendorRow> {
  const values = {
    vendorId: input.vendorId,
    tenantId: input.tenantId,
    name: input.name,
    status: input.status,
    verifiedBeneficiaryRef: input.verifiedBeneficiaryRef ?? null,
    verifiedAt: input.verifiedAt ?? null,
    bankingChangedAt: input.bankingChangedAt ?? null,
    bankingChangeVerifiedAt: input.bankingChangeVerifiedAt ?? null,
    pendingBeneficiaryRef: input.pendingBeneficiaryRef ?? null,
    allowedDestinationRefsJson: [...input.allowedDestinationRefs],
    accountAgeDays: input.accountAgeDays,
    dataClassification: input.dataClassification,
  };
  const [row] = await ex
    .insert(vendors)
    .values(values)
    .onConflictDoUpdate({
      target: [vendors.vendorId, vendors.tenantId],
      set: {
        name: values.name,
        status: values.status,
        verifiedBeneficiaryRef: values.verifiedBeneficiaryRef,
        verifiedAt: values.verifiedAt,
        bankingChangedAt: values.bankingChangedAt,
        bankingChangeVerifiedAt: values.bankingChangeVerifiedAt,
        pendingBeneficiaryRef: values.pendingBeneficiaryRef,
        allowedDestinationRefsJson: values.allowedDestinationRefsJson,
        accountAgeDays: values.accountAgeDays,
        dataClassification: values.dataClassification,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error('vendor upsert returned no row');
  return row;
}

export async function getInvoice(ex: DbExecutor, tenantId: string, invoiceId: string): Promise<InvoiceRow | null> {
  return first(
    ex
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.invoiceId, invoiceId)))
      .limit(1),
  );
}

export async function insertInvoice(
  ex: DbExecutor,
  input: {
    invoiceId: string;
    tenantId: string;
    vendorId: string;
    amountMinor: bigint;
    currency: string;
    purchaseOrderId?: string | null;
    status?: string;
    documentText?: string | null;
    untrusted?: boolean;
  },
): Promise<InvoiceRow> {
  const [row] = await ex
    .insert(invoices)
    .values({
      invoiceId: input.invoiceId,
      tenantId: input.tenantId,
      vendorId: input.vendorId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      purchaseOrderId: input.purchaseOrderId ?? null,
      status: input.status ?? 'OPEN',
      documentText: input.documentText ?? null,
      documentUntrusted: input.untrusted ?? true,
    })
    .returning();
  if (!row) throw new Error('invoice insert returned no row');
  return row;
}

export async function getPurchaseOrder(
  ex: DbExecutor,
  tenantId: string,
  purchaseOrderId: string,
): Promise<PurchaseOrderRow | null> {
  return first(
    ex
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.purchaseOrderId, purchaseOrderId)))
      .limit(1),
  );
}

export async function insertPurchaseOrder(
  ex: DbExecutor,
  input: {
    purchaseOrderId: string;
    tenantId: string;
    vendorId: string;
    amountMinor: bigint;
    currency: string;
    status?: string;
    matchedInvoiceIds?: readonly string[];
  },
): Promise<PurchaseOrderRow> {
  const [row] = await ex
    .insert(purchaseOrders)
    .values({
      purchaseOrderId: input.purchaseOrderId,
      tenantId: input.tenantId,
      vendorId: input.vendorId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: input.status ?? 'OPEN',
      matchedInvoiceIdsJson: [...(input.matchedInvoiceIds ?? [])],
    })
    .returning();
  if (!row) throw new Error('purchase order insert returned no row');
  return row;
}

// -- Ledger -------------------------------------------------------------------

export async function getLedgerEntry(
  ex: DbExecutor,
  tenantId: string,
  connectorIdempotencyKey: string,
): Promise<ConnectorLedgerRow | null> {
  return first(
    ex
      .select()
      .from(connectorLedger)
      .where(
        and(
          eq(connectorLedger.tenantId, tenantId),
          eq(connectorLedger.connectorIdempotencyKey, connectorIdempotencyKey),
        ),
      )
      .limit(1),
  );
}

/** The exactly-once guard: concurrent identical inserts collapse to the first. */
export async function putLedgerEntryIfAbsent(
  ex: DbExecutor,
  input: {
    tenantId: string;
    connectorId: string;
    connectorIdempotencyKey: string;
    operation: string;
    externalReference: string;
    receipt: Record<string, unknown>;
    amountMinor?: bigint | null;
    currency?: string | null;
    beneficiaryRef?: string | null;
    actionId?: string | null;
    executionId?: string | null;
    detailRedacted: Record<string, unknown>;
    recordedAt: Date;
  },
): Promise<{ inserted: boolean; entry: ConnectorLedgerRow }> {
  const inserted = await ex
    .insert(connectorLedger)
    .values({
      ledgerId: newId('ledger'),
      tenantId: input.tenantId,
      connectorId: input.connectorId,
      connectorIdempotencyKey: input.connectorIdempotencyKey,
      operation: input.operation,
      externalReference: input.externalReference,
      receiptHash: typeof input.receipt['receiptHash'] === 'string' ? (input.receipt['receiptHash'] as string) : '',
      receiptJson: input.receipt,
      amountMinor: input.amountMinor ?? null,
      currency: input.currency ?? null,
      beneficiaryRef: input.beneficiaryRef ?? null,
      actionId: input.actionId ?? null,
      executionId: input.executionId ?? null,
      detailJsonRedacted: input.detailRedacted,
      completedAt: input.recordedAt,
      createdAt: input.recordedAt,
    })
    .onConflictDoNothing({ target: [connectorLedger.tenantId, connectorLedger.connectorIdempotencyKey] })
    .returning();
  if (inserted[0]) return { inserted: true, entry: inserted[0] };
  const existing = await getLedgerEntry(ex, input.tenantId, input.connectorIdempotencyKey);
  if (!existing) throw new Error('ledger entry vanished after conflict');
  return { inserted: false, entry: existing };
}

export async function listLedger(ex: DbExecutor, tenantId: string): Promise<ConnectorLedgerRow[]> {
  return ex
    .select()
    .from(connectorLedger)
    .where(eq(connectorLedger.tenantId, tenantId))
    .orderBy(asc(connectorLedger.createdAt));
}

// -- Dispatch markers ---------------------------------------------------------

export async function recordDispatch(
  ex: DbExecutor,
  input: { tenantId: string; connectorIdempotencyKey: string; operation: string; startedAt: Date },
): Promise<ConnectorDispatchRow> {
  const [row] = await ex
    .insert(connectorDispatches)
    .values({
      dispatchId: newId('dispatch'),
      tenantId: input.tenantId,
      connectorIdempotencyKey: input.connectorIdempotencyKey,
      operation: input.operation,
      startedAt: input.startedAt,
    })
    .returning();
  if (!row) throw new Error('dispatch insert returned no row');
  return row;
}

/** Completes the most recent open marker for the key; a no-op when none is open. */
export async function completeDispatch(
  ex: DbExecutor,
  tenantId: string,
  connectorIdempotencyKey: string,
  outcome: string,
  completedAt: Date,
): Promise<void> {
  const open = await first(
    ex
      .select()
      .from(connectorDispatches)
      .where(
        and(
          eq(connectorDispatches.tenantId, tenantId),
          eq(connectorDispatches.connectorIdempotencyKey, connectorIdempotencyKey),
          isNull(connectorDispatches.completedAt),
        ),
      )
      .orderBy(desc(connectorDispatches.startedAt))
      .limit(1),
  );
  if (!open) return;
  await ex
    .update(connectorDispatches)
    .set({ completedAt, outcome })
    .where(
      and(
        eq(connectorDispatches.dispatchId, open.dispatchId),
        eq(connectorDispatches.tenantId, tenantId),
        isNull(connectorDispatches.completedAt),
      ),
    );
}

export async function listDispatches(
  ex: DbExecutor,
  tenantId: string,
  connectorIdempotencyKey: string,
): Promise<ConnectorDispatchRow[]> {
  return ex
    .select()
    .from(connectorDispatches)
    .where(
      and(
        eq(connectorDispatches.tenantId, tenantId),
        eq(connectorDispatches.connectorIdempotencyKey, connectorIdempotencyKey),
      ),
    )
    .orderBy(asc(connectorDispatches.startedAt));
}

// -- Enforcement modes --------------------------------------------------------

export async function getEnforcementMode(ex: DbExecutor, tenantId: string): Promise<EnforcementModeRow | null> {
  return first(ex.select().from(enforcementModes).where(eq(enforcementModes.tenantId, tenantId)).limit(1));
}

export async function setEnforcementMode(
  ex: DbExecutor,
  input: {
    tenantId: string;
    mode: EnforcementMode;
    reason?: string | null;
    changedByActorId?: string | null;
    changedByActorType?: ActorType | null;
    now?: Date;
  },
): Promise<EnforcementModeRow> {
  const now = input.now ?? new Date();
  const values = {
    tenantId: input.tenantId,
    mode: input.mode,
    reason: input.reason ?? null,
    protectedWritesAllowed: input.mode === 'ENFORCED',
    changedByActorId: input.changedByActorId ?? null,
    changedByActorType: input.changedByActorType ?? null,
    changedAt: now,
    updatedAt: now,
  };
  const [row] = await ex
    .insert(enforcementModes)
    .values(values)
    .onConflictDoUpdate({
      target: enforcementModes.tenantId,
      set: {
        mode: values.mode,
        reason: values.reason,
        protectedWritesAllowed: values.protectedWritesAllowed,
        changedByActorId: values.changedByActorId,
        changedByActorType: values.changedByActorType,
        changedAt: values.changedAt,
        updatedAt: values.updatedAt,
      },
    })
    .returning();
  if (!row) throw new Error('enforcement mode upsert returned no row');
  return row;
}

// -- Model evaluations --------------------------------------------------------

/** The domain-separation label for the model-evaluation output's encryption key. */
const MODEL_EVALUATION_PAYLOAD_PURPOSE = 'model-evaluation-payload';

/** The keys that may decrypt a model-evaluation output. */
function modelEvaluationKeys(explicit?: string | null): Buffer[] {
  const masters: string[] = [];
  for (const master of [explicit, ...verificationKeys()]) {
    if (typeof master === 'string' && master.length > 0 && !masters.includes(master)) masters.push(master);
  }
  return masters.map((master) => deriveKey(master, MODEL_EVALUATION_PAYLOAD_PURPOSE));
}

export async function insertModelEvaluation(
  ex: DbExecutor,
  input: {
    evaluationId: string;
    tenantId: string;
    actionId?: string | null;
    provider: string;
    modelId: string;
    promptVersion: string;
    schemaVersion: string;
    inputHash: string;
    outputValidated?: Record<string, unknown> | null;
    status: ModelEvaluationRow['status'];
    latencyMs?: number | null;
    tokenUsage?: Record<string, number> | null;
    errorClass?: string | null;
  },
  opts?: { hmacKey?: string | null },
): Promise<ModelEvaluationRow> {
  const master = opts?.hmacKey ?? currentKey();
  const output = input.outputValidated ?? null;
  const [row] = await ex
    .insert(modelEvaluations)
    .values({
      modelEvaluationId: input.evaluationId,
      tenantId: input.tenantId,
      actionId: input.actionId ?? null,
      provider: input.provider,
      modelId: input.modelId,
      promptVersion: input.promptVersion,
      schemaVersion: input.schemaVersion,
      inputHash: input.inputHash,
      // The validated model output is decision content: the risk hints a model
      // produced about an action. It is stored encrypted and read back in the
      // clear, so the reader above the repository sees the same shape it
      // always did.
      outputJsonValidated: master
        ? encryptNullableColumn(output, deriveKey(master, MODEL_EVALUATION_PAYLOAD_PURPOSE))
        : output,
      status: input.status,
      latencyMs: input.latencyMs ?? null,
      tokenUsageJson: input.tokenUsage ?? null,
      errorClass: input.errorClass ?? null,
    })
    .returning();
  if (!row) throw new Error('model evaluation insert returned no row');
  return withDecryptedOutput(row, modelEvaluationKeys(master));
}

/**
 * The row as the application sees it: the model output in the clear.
 *
 * An output written before encryption was enabled holds plaintext and is read
 * as it is.
 */
function withDecryptedOutput(row: ModelEvaluationRow, keys: readonly Buffer[]): ModelEvaluationRow {
  return { ...row, outputJsonValidated: readColumn<Record<string, unknown> | null>(row.outputJsonValidated, keys) };
}

export async function listRecentModelEvaluations(ex: DbExecutor, limit: number): Promise<ModelEvaluationRow[]> {
  const rows = await ex.select().from(modelEvaluations).orderBy(desc(modelEvaluations.createdAt)).limit(limit);
  const keys = modelEvaluationKeys();
  return rows.map((row) => withDecryptedOutput(row, keys));
}
