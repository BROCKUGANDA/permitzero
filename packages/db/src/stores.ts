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
import { withTenantBlindTransaction, withTenantTransaction } from './tenant.js';
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

/**
 * The outbox port, as the database implements it.
 *
 * Every method that mutates a row carries the row's own tenant. An outbox
 * event id is unique per tenant rather than globally, so a mutation that
 * carries only an id can be pointed at another tenant's row — which is how a
 * redrive became a cross-tenant write. The tenant is required here, not
 * optional: the queue-side port keeps it optional for compatibility, and the
 * adapter that bridges the two refuses to call through without it.
 */
export interface DbOutboxStore {
  insert(draft: DbOutboxDraft): Promise<ClaimedOutboxRow>;
  claimPending(limit: number, now: Date): Promise<ClaimedOutboxRow[]>;
  markPublished(id: string, publishedAt: Date, tenantId: string): Promise<boolean>;
  markFailed(id: string, errorClass: string, nextAttemptAt: Date, tenantId: string): Promise<boolean>;
  markDead(id: string, errorClass: string, tenantId: string): Promise<boolean>;
  getDeadLetter(id: string, tenantId: string): Promise<ClaimedOutboxRow | null>;
  countByStatus(): Promise<Record<string, number>>;
  redrive(id: string, reason: string, actorId: string, tenantId: string): Promise<ClaimedOutboxRow | null>;
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
  //
  // Two very different things can be passed in, and the difference decides
  // whether row-level security applies:
  //
  //   · a `Db` (the root pool) — the caller has NOT chosen a tenant, so every
  //     method below has to open its own tenant-scoped transaction from the
  //     tenant id it was given. Nearly every port method already receives one.
  //   · a `DbTransaction` — the caller already opened the transaction, and from
  //     0006 onwards the only supported way to open one for tenant work is
  //     `withTenantTransaction`, so the context is set. Opening a nested
  //     transaction here would take a second pool connection and deadlock under
  //     load, so these calls run exactly as they did before.
  const root = 'sql' in db ? db : null;
  // Narrowed again rather than reusing `root`: TypeScript only refines `db`
  // itself for the `in` check, so `root ? root.db : db` would leave the else
  // branch as the union.
  const ex: DbExecutor = 'sql' in db ? db.db : db;
  const auditHmacKey = opts?.auditHmacKey ?? null;

  /** Tenant-scoped statement: a transaction carrying `tenantId`, or the caller's own. */
  const run = <T>(tenantId: string, fn: (ex: DbExecutor) => Promise<T>): Promise<T> =>
    root ? withTenantTransaction(root, tenantId, (tx) => fn(tx)) : fn(ex);

  /**
   * Cross-tenant statement, permitted only for the outbox: claiming with
   * `FOR UPDATE SKIP LOCKED` across all tenants is what stops one busy tenant
   * delaying delivery for the rest. The blind flag opens SELECT on the
   * delivery backlog and an UPDATE limited to the claim columns — nothing
   * else (`infra/migrations/0007_rls_write_scope.sql`).
   */
  const runBlind = <T>(fn: (ex: DbExecutor) => Promise<T>): Promise<T> =>
    root ? withTenantBlindTransaction(root, (tx) => fn(tx)) : fn(ex);

  /**
   * A tenant-scoped write without a tenant is a bug, not a no-op.
   *
   * Silently matching nothing would look exactly like a successful publish,
   * and the event would sit in the outbox forever with nobody looking for it.
   */
  const requireTenant = (tenantId: string): string => {
    if (!tenantId) {
      throw new Error('outbox store: a tenant-scoped write was called without a tenant id.');
    }
    return tenantId;
  };

  const permits: PermitStore = {
    insert: (permit: PersistedPermit) => run(permit.tenantId, (e) => insertPermit(e, permit)).then(() => undefined),
    consumeIfUnused: (permitId: string, tenantId: string, now: Date): Promise<PermitConsumeResult> =>
      run(tenantId, (e) => consumePermit(e, permitId, tenantId, now)),
    findByTokenHash: (tokenHash: string, tenantId: string) =>
      run(tenantId, async (e) => {
        const row = await findPermitByTokenHash(e, tokenHash, tenantId);
        return row ? toPersistedPermit(row) : null;
      }),
    revoke: (permitId: string, tenantId: string, reason: string, now: Date) =>
      run(tenantId, (e) => revokePermit(e, tenantId, permitId, reason, now)),
    revokeByAction: (actionId: string, tenantId: string, reason: string, now: Date) =>
      run(tenantId, (e) => revokePermitsByAction(e, tenantId, actionId, reason, now)).then(() => undefined),
    // Deliberately not implemented any more. It existed only to distinguish
    // `PERMIT_MISSING` from `PERMIT_TENANT_MISMATCH` for the operator message,
    // and doing that requires reading another tenant's `permits` row — which is
    // precisely the thing row-level security now refuses. The port documents the
    // optional-method contract: without it the broker reports `PERMIT_MISSING`
    // in both cases, and the API still maps to 404 rather than 403, so the
    // observable behaviour the PRD asked for is unchanged and the cross-tenant
    // read is gone.
  };

  const executions: ExecutionStore = {
    recordIntent: (execution: PersistedExecution) =>
      run(execution.tenantId, (e) => insertExecution(e, execution)).then(() => undefined),
    markDispatched: (executionId: string, tenantId: string, dispatchStartedAt: Date) =>
      run(tenantId, async (e) => {
        const row = await markExecutionDispatched(e, executionId, tenantId, dispatchStartedAt);
        return row ? toPersistedExecution(row) : null;
      }),
    markResult: (update: ExecutionResultUpdate) =>
      run(update.tenantId, async (e) => {
        const row = await markExecutionResult(e, update);
        return row ? toPersistedExecution(row) : null;
      }),
    findLatestByAction: (actionId: string, tenantId: string) =>
      run(tenantId, async (e) => {
        const row = await findLatestExecutionByAction(e, actionId, tenantId);
        return row ? toPersistedExecution(row) : null;
      }),
    findByIdempotencyKey: (connectorIdempotencyKey: string, tenantId: string) =>
      run(tenantId, async (e) => {
        const row = await findExecutionByConnectorKey(e, connectorIdempotencyKey, tenantId);
        return row ? toPersistedExecution(row) : null;
      }),
    listUnknownOutcomes: (tenantId: string | null, limit?: number) => {
      if (tenantId === null && root) {
        // "All tenants" is not a thing this connection can ask for. Sweeps
        // iterate tenants explicitly instead — failing loudly here is the point,
        // because quietly returning [] would look like a healthy sweep that found
        // nothing to reconcile.
        throw new Error(
          'listUnknownOutcomes(null) cannot enumerate tenants under row-level security; iterate tenant ids and pass one.',
        );
      }
      return run(tenantId ?? '', (e) => listUnknownOutcomeExecutions(e, tenantId, limit ?? 100)).then((rows) =>
        rows.map(toPersistedExecution),
      );
    },
  };

  const actions: ActionStore = {
    loadAction: (actionId: string, tenantId: string) =>
      run(tenantId, async (e) => {
        const row = await getAction(e, tenantId, actionId);
        return row ? toActionRecord(row) : null;
      }),
    transitionState: (input: ActionTransitionInput) =>
      run(input.tenantId, (e) =>
        transitionAction(e, {
          tenantId: input.tenantId,
          actionId: input.actionId,
          to: input.to,
          expectedVersion: input.expectedVersion,
          expectedFrom: input.expectedFrom,
          patch: input.patch,
          now: input.now,
        }),
      ),
  };

  const data: ConnectorDataStore = {
    getVendor: (tenantId: string, vendorId: string) =>
      run(tenantId, async (e) => {
        const row = await getVendor(e, tenantId, vendorId);
        return row ? toVendorRecord(row) : null;
      }),
    listVendors: (tenantId: string, limit: number) =>
      run(tenantId, (e) => listVendors(e, tenantId, limit)).then((rows) => rows.map(toVendorRecord)),
    putVendor: (vendor) =>
      run(vendor.tenantId, (e) =>
        upsertVendor(e, {
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
        }),
      ).then(() => undefined),
    getInvoice: (tenantId: string, invoiceId: string) =>
      run(tenantId, async (e) => {
        const row = await getInvoice(e, tenantId, invoiceId);
        return row ? toInvoiceRecord(row) : null;
      }),
    getPurchaseOrder: (tenantId: string, purchaseOrderId: string) =>
      run(tenantId, async (e) => {
        const row = await getPurchaseOrder(e, tenantId, purchaseOrderId);
        return row ? toPurchaseOrderRecord(row) : null;
      }),
    getLedgerEntry: (tenantId: string, connectorIdempotencyKey: string) =>
      run(tenantId, async (e) => {
        const row = await getLedgerEntry(e, tenantId, connectorIdempotencyKey);
        return row ? toConnectorLedgerEntry(row) : null;
      }),
    putLedgerEntryIfAbsent: (entry): Promise<LedgerInsertResult> =>
      run(entry.tenantId, async (e) => {
        const receipt = receiptToJson(entry.receipt) ?? {};
        const result = await putLedgerEntryIfAbsent(e, {
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
      }),
    listLedger: (tenantId: string) =>
      run(tenantId, (e) => listLedger(e, tenantId)).then((rows) => rows.map(toConnectorLedgerEntry)),
    recordDispatch: (record: ConnectorDispatchRecord) =>
      run(record.tenantId, (e) =>
        recordDispatch(e, {
          tenantId: record.tenantId,
          connectorIdempotencyKey: record.connectorIdempotencyKey,
          operation: record.operation,
          startedAt: record.startedAt,
        }),
      ).then(() => undefined),
    completeDispatch: (tenantId: string, connectorIdempotencyKey: string, outcome: string, completedAt: Date) =>
      run(tenantId, (e) => completeDispatch(e, tenantId, connectorIdempotencyKey, outcome, completedAt)),
    listDispatches: (tenantId: string, connectorIdempotencyKey: string) =>
      run(tenantId, (e) => listDispatches(e, tenantId, connectorIdempotencyKey)).then((rows) =>
        rows.map(toConnectorDispatchRecord),
      ),
  };

  const audit: AuditSink = {
    append: (event: AuditSinkEvent) =>
      run(event.tenantId, (e) =>
        appendAuditEvent(
          e,
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
        ),
      ).then(() => undefined),
  };

  const outbox: DbOutboxStore = {
    insert: (draft: DbOutboxDraft) =>
      run(draft.tenantId, (e) =>
        insertOutboxEvent(e, {
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
        }),
      ).then(claimedFromInsert),
    // The claim is the one deliberately cross-tenant write. It has to be: a
    // per-tenant claim loop would let one busy tenant starve the queue behind
    // it. What it may touch is narrow — the lease columns of the rows it is
    // about to publish — and `infra/migrations/0007_rls_write_scope.sql` is
    // what holds it to that, so a blind transaction cannot use this path to
    // change a row's status.
    claimPending: (limit: number, now: Date) => runBlind((e) => claimOutboxEvents(e, limit, now)),
    // Every status transition is tenant-scoped. It used to run blind, which
    // meant the runtime role could move any tenant's row — the write half of
    // the hole `0007` closes. The dispatcher knows which tenant each row
    // belongs to, so the tenant travels with the call.
    markPublished: (id: string, publishedAt: Date, tenantId: string) =>
      run(requireTenant(tenantId), (e) => markOutboxPublished(e, id, publishedAt, tenantId)),
    markFailed: (id: string, errorClass: string, nextAttemptAt: Date, tenantId: string) =>
      run(requireTenant(tenantId), (e) => markOutboxFailed(e, id, errorClass, nextAttemptAt, tenantId)),
    markDead: (id: string, errorClass: string, tenantId: string) =>
      run(requireTenant(tenantId), (e) => markOutboxDead(e, id, errorClass, tenantId)),
    getDeadLetter: (id: string, tenantId: string) =>
      run(requireTenant(tenantId), async (e) => {
        const row = await getOutboxEvent(e, id, tenantId);
        return row && row.status === 'DEAD' ? claimedFromInsert(row) : null;
      }),
    // A platform-wide delivery total, not tenant data: the same read the
    // cross-tenant claim makes, and the reason the blind flag opens SELECT on
    // `outbox_events` and nothing else.
    countByStatus: () => runBlind((e) => countOutboxByStatus(e)),
    // Reason/actor are accepted for port shape; the caller audits the redrive.
    redrive: (id: string, _reason: string, _actorId: string, tenantId: string) =>
      run(requireTenant(tenantId), async (e) => {
        const row = await redriveOutboxEvent(e, id, tenantId);
        return row ? claimedFromInsert(row) : null;
      }),
  };

  return { permits, executions, actions, data, audit, outbox };
}

/** Resolve the connector row authorized for a tool (broker `ConnectorResolver`). */
export async function resolveConnectorForTool(
  db: Db,
  tenantId: string,
  toolName: string,
): Promise<ReturnType<typeof toConnectorRecord> | null> {
  const row = await withTenantTransaction(db, tenantId, (tx) => findConnectorForTool(tx, tenantId, toolName));
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
  const root = 'sql' in db ? db : null;
  // Narrowed again rather than reusing `root`: TypeScript only refines `db`
  // itself for the `in` check, so `root ? root.db : db` would leave the else
  // branch as the union.
  const ex: DbExecutor = 'sql' in db ? db.db : db;
  const broker = new Broker({
    permits,
    actions: stores.actions,
    executions: stores.executions,
    data: stores.data,
    audit: stores.audit,
    resolveConnector: async (tenantId, toolName) => {
      // Same rule as the stores: a root pool has to choose its tenant per call,
      // a caller-supplied transaction already has one.
      const row = root
        ? await withTenantTransaction(root, tenantId, (tx) => findConnectorForTool(tx, tenantId, toolName))
        : await findConnectorForTool(ex, tenantId, toolName);
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
