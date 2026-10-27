/**
 * Durable port adapters: the broker ports (and, structurally, the queue
 * outbox port) backed by PostgreSQL. This is the only place broker concepts
 * meet SQL; it lives in `@permitzero/db` (not `@permitzero/broker`) so the
 * broker keeps zero database dependencies and the dependency arrow points one
 * way: db → broker. The outbox adapter is assigned — never imported — to the
 * queue `OutboxStore` type by callers, avoiding a db ↔ queue cycle.
 */
import type {
  ActionStore,
  ActionTransitionInput,
  AuditSink,
  AuditSinkEvent,
  ConnectorDataStore,
  ConnectorDispatchRecord,
  ExecutionResultUpdate,
  ExecutionStore,
  LedgerInsertResult,
  PermitConsumeResult,
  PermitStore,
  PersistedExecution,
  PersistedPermit,
} from '@permitzero/broker';
import { Broker, PermitService, SimulatedFinanceConnector } from '@permitzero/broker';
import type { Clock } from '@permitzero/broker';
import { newId } from '@permitzero/domain';
import type { Db, DbExecutor } from './client.js';
import {
  toActionRecord,
  toConnectorDispatchRecord,
  toConnectorLedgerEntry,
  toConnectorRecord,
  toInvoiceRecord,
  toPersistedExecution,
  toPersistedPermit,
  toPurchaseOrderRecord,
  toVendorRecord,
} from './mappers.js';

function newTraceId(): string {
  return newId('trace');
}
import { getAction, transitionAction } from './repos/actions.js';
import { appendAuditEvent } from './repos/audit.js';
import {
  completeDispatch,
  findConnectorForTool,
  getInvoice,
  getLedgerEntry,
  getPurchaseOrder,
  getVendor,
  listDispatches,
  listLedger,
  listVendors,
  putLedgerEntryIfAbsent,
  recordDispatch,
  upsertVendor,
} from './repos/catalog.js';
import {
  consumePermit,
  findExecutionByConnectorKey,
  findLatestExecutionByAction,
  findPermitByTokenHash,
  findPermitByTokenHashAnyTenant,
  insertExecution,
  insertPermit,
  listUnknownOutcomeExecutions,
  markExecutionDispatched,
  markExecutionResult,
  revokePermit,
  revokePermitsByAction,
} from './repos/execution.js';
import {
  claimOutboxEvents,
  countOutboxByStatus,
  getOutboxEvent,
  insertOutboxEvent,
  markOutboxDead,
  markOutboxFailed,
  markOutboxPublished,
  redriveOutboxEvent,
} from './repos/outbox.js';
import type { ClaimedOutboxRow, OutboxStatusName, QueueName } from './repos/outbox.js';

export interface DbStoresOptions {
  auditHmacKey?: string | null;
}

export interface DbStores {
  permits: PermitStore;
  executions: ExecutionStore;
  actions: ActionStore;
  data: ConnectorDataStore;
  audit: AuditSink;
  outbox: DbOutboxStore;
}

/** Queue-`OutboxStore`-shaped port, declared locally to avoid a db ↔ queue import cycle. */
export interface DbOutboxDraft {
  tenantId: string;
  eventType: string;
  queueName: QueueName;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  nextAttemptAt?: Date | null;
  traceId?: string | null;
}

export interface DbOutboxStore {
  insert(draft: DbOutboxDraft): Promise<ClaimedOutboxRow>;
  claimPending(limit: number, now: Date): Promise<ClaimedOutboxRow[]>;
  markPublished(id: string, publishedAt: Date): Promise<boolean>;
  markFailed(id: string, errorClass: string, nextAttemptAt: Date): Promise<boolean>;
  markDead(id: string, errorClass: string): Promise<boolean>;
  getDeadLetter(id: string): Promise<ClaimedOutboxRow | null>;
  countByStatus(): Promise<Record<string, number>>;
  redrive(id: string, reason: string, actorId: string): Promise<ClaimedOutboxRow | null>;
}

function receiptToJson(receipt: PersistedExecution['receipt']): Record<string, unknown> | null {
  if (!receipt) return null;
  return {
    externalReference: receipt.externalReference,
    receiptHash: receipt.receiptHash,
    amountMinor: receipt.amountMinor,
    currency: receipt.currency,
    beneficiaryRef: receipt.beneficiaryRef,
    completedAt: receipt.completedAt.toISOString(),
    simulated: receipt.simulated,
  };
}

function claimedFromInsert(row: {
  outboxEventId: string;
  tenantId: string;
  eventType: string;
  queueName: string;
  payloadJson: unknown;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  lastErrorClass: string | null;
  createdAt: Date;
}): ClaimedOutboxRow {
  const payload =
    typeof row.payloadJson === 'object' && row.payloadJson !== null && !Array.isArray(row.payloadJson)
      ? (row.payloadJson as Record<string, unknown>)
      : {};
  const trace = payload['trace_id'];
  return {
    id: row.outboxEventId,
    tenantId: row.tenantId,
    eventType: row.eventType,
    queueName: row.queueName as QueueName,
    payload,
    status: row.status as OutboxStatusName,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt,
    lastErrorClass: row.lastErrorClass,
    createdAt: row.createdAt,
    traceId: typeof trace === 'string' ? trace : null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function createDbStores(db: Db | DbExecutor, opts?: DbStoresOptions): DbStores {
  // A transaction satisfies DbExecutor structurally, so callers can scope a
  // whole pipeline (intake, approval quorum, execute) to one commit.
  const ex: DbExecutor = 'db' in db ? db.db : db;
  const auditHmacKey = opts?.auditHmacKey ?? null;

  const permits: PermitStore = {
    insert: (permit: PersistedPermit) => insertPermit(ex, permit).then(() => undefined),
    consumeIfUnused: (permitId: string, tenantId: string, now: Date): Promise<PermitConsumeResult> =>
      consumePermit(ex, permitId, tenantId, now),
    findByTokenHash: async (tokenHash: string, tenantId: string) => {
      const row = await findPermitByTokenHash(ex, tokenHash, tenantId);
      return row ? toPersistedPermit(row) : null;
    },
    revoke: (permitId: string, tenantId: string, reason: string, now: Date) =>
      revokePermit(ex, tenantId, permitId, reason, now),
    revokeByAction: (actionId: string, tenantId: string, reason: string, now: Date) =>
      revokePermitsByAction(ex, tenantId, actionId, reason, now).then(() => undefined),
    findByTokenHashCrossTenant: async (tokenHash: string) => {
      const row = await findPermitByTokenHashAnyTenant(ex, tokenHash);
      return row ? toPersistedPermit(row) : null;
    },
  };

  const executions: ExecutionStore = {
    recordIntent: (execution: PersistedExecution) => insertExecution(ex, execution).then(() => undefined),
    markDispatched: async (executionId: string, tenantId: string, dispatchStartedAt: Date) => {
      const row = await markExecutionDispatched(ex, executionId, tenantId, dispatchStartedAt);
      return row ? toPersistedExecution(row) : null;
    },
    markResult: async (update: ExecutionResultUpdate) => {
      const row = await markExecutionResult(ex, update);
      return row ? toPersistedExecution(row) : null;
    },
    findLatestByAction: async (actionId: string, tenantId: string) => {
      const row = await findLatestExecutionByAction(ex, actionId, tenantId);
      return row ? toPersistedExecution(row) : null;
    },
    findByIdempotencyKey: async (connectorIdempotencyKey: string, tenantId: string) => {
      const row = await findExecutionByConnectorKey(ex, connectorIdempotencyKey, tenantId);
      return row ? toPersistedExecution(row) : null;
    },
    listUnknownOutcomes: async (tenantId: string | null, limit?: number) => {
      const rows = await listUnknownOutcomeExecutions(ex, tenantId, limit ?? 100);
      return rows.map(toPersistedExecution);
    },
  };

  const actions: ActionStore = {
    loadAction: async (actionId: string, tenantId: string) => {
      const row = await getAction(ex, tenantId, actionId);
      return row ? toActionRecord(row) : null;
    },
    transitionState: (input: ActionTransitionInput) =>
      transitionAction(ex, {
        tenantId: input.tenantId,
        actionId: input.actionId,
        to: input.to,
        expectedVersion: input.expectedVersion,
        expectedFrom: input.expectedFrom,
        patch: input.patch,
        now: input.now,
      }),
  };

  const data: ConnectorDataStore = {
    getVendor: async (tenantId: string, vendorId: string) => {
      const row = await getVendor(ex, tenantId, vendorId);
      return row ? toVendorRecord(row) : null;
    },
    listVendors: async (tenantId: string, limit: number) => {
      const rows = await listVendors(ex, tenantId, limit);
      return rows.map(toVendorRecord);
    },
    putVendor: (vendor) =>
      upsertVendor(ex, {
        vendorId: vendor.vendorId,
        tenantId: vendor.tenantId,
        name: vendor.name,
        status: vendor.status,
        verifiedBeneficiaryRef: vendor.verifiedBeneficiaryRef,
        verifiedAt: vendor.verifiedAt,
        bankingChangedAt: vendor.bankingChangedAt,
        bankingChangeVerifiedAt: vendor.bankingChangeVerifiedAt,
        pendingBeneficiaryRef: vendor.pendingBeneficiaryRef,
        allowedDestinationRefs: [...vendor.allowedDestinationRefs],
        accountAgeDays: vendor.accountAgeDays,
        dataClassification: vendor.dataClassification,
      }).then(() => undefined),
    getInvoice: async (tenantId: string, invoiceId: string) => {
      const row = await getInvoice(ex, tenantId, invoiceId);
      return row ? toInvoiceRecord(row) : null;
    },
    getPurchaseOrder: async (tenantId: string, purchaseOrderId: string) => {
      const row = await getPurchaseOrder(ex, tenantId, purchaseOrderId);
      return row ? toPurchaseOrderRecord(row) : null;
    },
    getLedgerEntry: async (tenantId: string, connectorIdempotencyKey: string) => {
      const row = await getLedgerEntry(ex, tenantId, connectorIdempotencyKey);
      return row ? toConnectorLedgerEntry(row) : null;
    },
    putLedgerEntryIfAbsent: async (entry): Promise<LedgerInsertResult> => {
      const receipt = receiptToJson(entry.receipt) ?? {};
      const result = await putLedgerEntryIfAbsent(ex, {
        tenantId: entry.tenantId,
        connectorId: entry.connectorId,
        connectorIdempotencyKey: entry.connectorIdempotencyKey,
        operation: entry.operation,
        externalReference: entry.externalReference,
        receipt,
        amountMinor: BigInt(entry.receipt.amountMinor),
        currency: entry.receipt.currency,
        beneficiaryRef: entry.receipt.beneficiaryRef,
        actionId: entry.actionId,
        executionId: entry.executionId,
        detailRedacted: { ...entry.detailRedacted },
        recordedAt: entry.recordedAt,
      });
      return { inserted: result.inserted, entry: toConnectorLedgerEntry(result.entry) };
    },
    listLedger: async (tenantId: string) => {
      const rows = await listLedger(ex, tenantId);
      return rows.map(toConnectorLedgerEntry);
    },
    recordDispatch: (record: ConnectorDispatchRecord) =>
      recordDispatch(ex, {
        tenantId: record.tenantId,
        connectorIdempotencyKey: record.connectorIdempotencyKey,
        operation: record.operation,
        startedAt: record.startedAt,
      }).then(() => undefined),
    completeDispatch: (tenantId: string, connectorIdempotencyKey: string, outcome: string, completedAt: Date) =>
      completeDispatch(ex, tenantId, connectorIdempotencyKey, outcome, completedAt),
    listDispatches: async (tenantId: string, connectorIdempotencyKey: string) => {
      const rows = await listDispatches(ex, tenantId, connectorIdempotencyKey);
      return rows.map(toConnectorDispatchRecord);
    },
  };

  const audit: AuditSink = {
    append: async (event: AuditSinkEvent) => {
      await appendAuditEvent(
        ex,
        {
          tenantId: event.tenantId,
          actionId: event.actionId,
          runId: event.runId,
          actorType: event.actorType,
          actorId: event.actorId,
          eventType: event.eventType,
          eventTime: event.eventTime,
          traceId: event.traceId ?? newTraceId(),
          policyRevisionId: event.policyRevisionId,
          payload: { ...event.payloadRedacted },
        },
        { hmacKey: auditHmacKey },
      );
    },
  };

  const outbox: DbOutboxStore = {
    insert: async (draft: DbOutboxDraft) => {
      const row = await insertOutboxEvent(ex, {
        tenantId: draft.tenantId,
        aggregateType: asString(draft.payload['aggregate_type']) ?? 'action',
        aggregateId:
          asString(draft.payload['action_id']) ??
          asString(draft.payload['aggregate_id']) ??
          `obx:${draft.traceId ?? 'untraced'}`,
        eventType: draft.eventType,
        queueName: draft.queueName,
        payload: { ...draft.payload },
        maxAttempts: draft.maxAttempts,
        nextAttemptAt: draft.nextAttemptAt ?? null,
        traceId: draft.traceId ?? null,
      });
      return claimedFromInsert(row);
    },
    claimPending: (limit: number, now: Date) => claimOutboxEvents(ex, limit, now),
    markPublished: (id: string, publishedAt: Date) => markOutboxPublished(ex, id, publishedAt),
    markFailed: (id: string, errorClass: string, nextAttemptAt: Date) => markOutboxFailed(ex, id, errorClass, nextAttemptAt),
    markDead: (id: string, errorClass: string) => markOutboxDead(ex, id, errorClass),
    getDeadLetter: async (id: string) => {
      const row = await getOutboxEvent(ex, id);
      return row && row.status === 'DEAD' ? claimedFromInsert(row) : null;
    },
    countByStatus: () => countOutboxByStatus(ex),
    // Reason/actor are accepted for port shape; the caller audits the redrive.
    redrive: async (id: string, _reason: string, _actorId: string) => {
      const row = await redriveOutboxEvent(ex, id);
      return row ? claimedFromInsert(row) : null;
    },
  };

  return { permits, executions, actions, data, audit, outbox };
}

/** Resolve the connector row authorized for a tool (broker `ConnectorResolver`). */
export async function resolveConnectorForTool(
  db: Db,
  tenantId: string,
  toolName: string,
): Promise<ReturnType<typeof toConnectorRecord> | null> {
  const row = await findConnectorForTool(db.db, tenantId, toolName);
  return row ? toConnectorRecord(row) : null;
}

export interface BrokerFactoryOptions {
  signingKey: string;
  signingKeyId: string;
  auditHmacKey?: string | null;
  clock?: Clock;
}

export interface BuiltBroker {
  broker: Broker;
  permits: PermitService;
  stores: DbStores;
}

/**
 * A broker wired to PostgreSQL. The API and the worker share this so the two
 * processes can never disagree about what backs execution. Accepts a
 * transaction for callers that issue permits inside a larger commit.
 */
export function createBroker(db: Db | DbExecutor, opts: BrokerFactoryOptions): BuiltBroker {
  const stores = createDbStores(db, { auditHmacKey: opts.auditHmacKey ?? null });
  const clock = opts.clock;
  const permits = new PermitService({
    signingKey: opts.signingKey,
    signingKeyId: opts.signingKeyId,
    store: stores.permits,
    ...(clock ? { clock } : {}),
  });
  const ex: DbExecutor = 'db' in db ? db.db : db;
  const broker = new Broker({
    permits,
    actions: stores.actions,
    executions: stores.executions,
    data: stores.data,
    audit: stores.audit,
    resolveConnector: async (tenantId, toolName) => {
      const row = await findConnectorForTool(ex, tenantId, toolName);
      return row ? toConnectorRecord(row) : null;
    },
    getConnector: (record) =>
      new SimulatedFinanceConnector({
        connectorId: record.connectorId,
        credentialRef: record.credentialRef,
        data: stores.data,
        ...(clock ? { clock } : {}),
      }),
    ...(clock ? { clock } : {}),
  });
  return { broker, permits, stores };
}
