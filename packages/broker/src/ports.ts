/**
 * Persistence and observation ports for `@permitzero/broker`.
 *
 * The broker and the permit service are *pure* with respect to storage: they
 * depend on the narrow interfaces declared here and never on `@permitzero/db`
 * directly. That has three consequences this package relies on:
 *
 *  1. `packages/db` is developed concurrently and may not exist yet, so the
 *     broker must compile without it (see `db-stores.ts`, which accepts the db
 *     module as a structural type).
 *  2. Every invariant — atomic single-use consumption, intent-before-dispatch,
 *     optimistic concurrency — is expressible as a property of a *port*, so it
 *     can be tested against `memory-stores.ts` and re-tested against PostgreSQL
 *     without changing a line of broker logic.
 *  3. "Policy store unavailable" stays a caller-side fail-closed path instead of
 *     a swallowed exception inside the broker.
 *
 * Column names in the comments match PRD §9.1 so the DB adapter is a mechanical
 * mapping rather than a redesign.
 */
import type {
  ActionRecord,
  ActionState,
  ActorType,
  ExecutionRecord,
  ExecutionState,
  InvoiceRecord,
  PermitRecord,
  PurchaseOrderRecord,
  VendorRecord,
} from '@permitzero/domain';

/** Injectable clock. Every timestamp in this package comes from here so tests
 * are deterministic and expiry can be exercised without sleeping. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

// ---------------------------------------------------------------------------
// Connector receipt — the proof that an effect happened.
//
// Shape is pinned by `docs/module-contracts.md` and validated on the wire by
// `executeActionResponseSchema.receipt` (strict): exactly these seven fields.
// Adding a field here breaks API response validation, so extra connector detail
// lives on the ledger entry instead.
// ---------------------------------------------------------------------------

export interface ConnectorReceipt {
  externalReference: string;
  receiptHash: string;
  amountMinor: number;
  currency: string;
  beneficiaryRef: string;
  completedAt: Date;
  simulated: true;
}

// ---------------------------------------------------------------------------
// permits
// ---------------------------------------------------------------------------

/**
 * The `permits` row (PRD §9.1) plus the two columns this package needs beyond
 * the PRD list:
 *
 *  - `token_hash` — HMAC of the token's identifying part. The raw token is
 *    NEVER persisted (PRD §9.1: "never store reusable raw bearer permits in
 *    logs"). Requires a unique index on `(tenant_id, token_hash)`.
 *  - `revoke_reason` — why an operator revoked it; audit evidence.
 *
 * `version` is the optimistic-concurrency column the PRD requires on `permits`.
 */
export interface PersistedPermit extends PermitRecord {
  tokenHash: string;
  revokeReason: string | null;
  version: number;
}

export interface PermitConsumeResult {
  consumed: boolean;
  row: PersistedPermit | null;
}

export interface PermitStore {
  insert(permit: PersistedPermit): Promise<void>;
  /**
   * Atomic single-use consumption. MUST be one statement with a
   * `consumed_at IS NULL` predicate so two concurrent workers cannot both win:
   *
   *   UPDATE permits SET consumed_at = $3, version = version + 1
   *    WHERE id = $1 AND tenant_id = $2 AND consumed_at IS NULL
   *    RETURNING *;
   *
   * `consumed` is false when zero rows came back.
   */
  consumeIfUnused(
    permitId: string,
    tenantId: string,
    now: Date,
  ): Promise<PermitConsumeResult>;
  /**
   * Locate a permit by token HMAC inside one tenant. Implementations MUST scope
   * by `tenant_id` (row-level security); the permit service performs the
   * remaining binding checks itself.
   */
  findByTokenHash(tokenHash: string, tenantId: string): Promise<PersistedPermit | null>;
  revoke(permitId: string, tenantId: string, reason: string, now: Date): Promise<void>;
  revokeByAction(actionId: string, tenantId: string, reason: string, now: Date): Promise<void>;
  /**
   * OPTIONAL diagnostic lookup, used only to tell "no such permit"
   * (`PERMIT_MISSING`) apart from "genuine permit presented in the wrong
   * tenant" (`PERMIT_TENANT_MISMATCH`).
   *
   * It is safe because reaching it requires the caller to already hold a token
   * whose HMAC matches an issued permit — the nonce inside is 256 bits of
   * secret, so this is not an existence oracle for arbitrary ids. Callers that
   * omit it simply get `PERMIT_MISSING` in both cases. The API layer MUST map
   * `PERMIT_TENANT_MISMATCH` to HTTP 404, never 403 (PRD §7.5).
   */
  findByTokenHashCrossTenant?(tokenHash: string): Promise<PersistedPermit | null>;
}

// ---------------------------------------------------------------------------
// executions
// ---------------------------------------------------------------------------

/** The `executions` row (PRD §9.1) plus the receipt body and provenance. */
export interface PersistedExecution extends ExecutionRecord {
  /** Permit that authorized this attempt. Evidence only; never the token. */
  permitId: string | null;
  permitNonceHash: string | null;
  actorId: string;
  traceId: string;
  /** Full connector receipt once one exists (execution + reconciliation). */
  receipt: ConnectorReceipt | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExecutionResultUpdate {
  executionId: string;
  tenantId: string;
  state: ExecutionState;
  resultReceivedAt: Date;
  externalReference?: string | null;
  receiptHash?: string | null;
  receipt?: ConnectorReceipt | null;
  errorClass?: string | null;
  retryAfterAt?: Date | null;
}

export interface ExecutionStore {
  /**
   * Commit the intent row BEFORE any dispatch (FR-035, invariant 5-9). The
   * broker treats a failure here as fatal and does not call the connector.
   */
  recordIntent(execution: PersistedExecution): Promise<void>;
  /** Intent is durable and the request is about to leave the process. */
  markDispatched(
    executionId: string,
    tenantId: string,
    dispatchStartedAt: Date,
  ): Promise<PersistedExecution | null>;
  markResult(update: ExecutionResultUpdate): Promise<PersistedExecution | null>;
  findLatestByAction(actionId: string, tenantId: string): Promise<PersistedExecution | null>;
  findByIdempotencyKey(
    connectorIdempotencyKey: string,
    tenantId: string,
  ): Promise<PersistedExecution | null>;
  /** Reconciliation sweep. `null` tenant means "all tenants" (service role). */
  listUnknownOutcomes(tenantId: string | null, limit?: number): Promise<PersistedExecution[]>;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

export type ActionTransitionFailureReason =
  | 'NOT_FOUND'
  | 'STATE_MISMATCH'
  | 'VERSION_CONFLICT';

export type ActionTransitionResult =
  | { ok: true; action: ActionRecord }
  | {
      ok: false;
      reason: ActionTransitionFailureReason;
      detail: string;
      current: ActionRecord | null;
      expectedVersion?: number;
      actualVersion?: number;
    };

export interface ActionTransitionInput {
  actionId: string;
  tenantId: string;
  to: ActionState;
  /** Optimistic concurrency: the version the caller loaded. Required. */
  expectedVersion: number;
  now: Date;
  /** Optional compare-and-swap on state as well as version. */
  expectedFrom?: ActionState;
  /** Non-state fields the transition legitimately updates. */
  patch?: Partial<
    Pick<ActionRecord, 'decision' | 'decisionReasonCodes' | 'policyRevisionId' | 'expiresAt'>
  >;
}

export interface ActionStore {
  loadAction(actionId: string, tenantId: string): Promise<ActionRecord | null>;
  /**
   * Validate with `assertTransition` (throws `IllegalTransitionError` for an
   * illegal pair — an unknown transition is a bug, not a permissive default),
   * then compare-and-swap on `expectedVersion`. A stale version returns a typed
   * `VERSION_CONFLICT` failure; it must never silently overwrite.
   */
  transitionState(input: ActionTransitionInput): Promise<ActionTransitionResult>;
}

// ---------------------------------------------------------------------------
// connector-owned business data (vendors / invoices / purchase orders / ledger)
// ---------------------------------------------------------------------------

/**
 * One row of `connector_ledger`, keyed by the CONNECTOR idempotency key. This is
 * the duplicate-payment defense: a repeated key returns the original receipt and
 * creates no second effect (PRD §12.5, Master Prompt §9).
 */
export interface ConnectorLedgerEntry {
  tenantId: string;
  connectorIdempotencyKey: string;
  /** The tool that produced the effect, e.g. `payment.execute`. */
  operation: string;
  externalReference: string;
  receipt: ConnectorReceipt;
  /** Effect detail beyond the receipt contract. Already redacted. */
  detailRedacted: Record<string, unknown>;
  recordedAt: Date;
}

/**
 * A connector call was *started*. Written before the effect is attempted so that
 * reconciliation can distinguish "definitely did not happen" from "we lost the
 * process mid-flight" (the latter is `MANUAL_REVIEW`, never a blind retry).
 */
export interface ConnectorDispatchRecord {
  tenantId: string;
  connectorIdempotencyKey: string;
  operation: string;
  startedAt: Date;
  /** `null` while in flight or when the worker died before completing. */
  completedAt: Date | null;
  /** `null` when unknown; otherwise the connector's declared outcome. */
  outcome: string | null;
}

export interface LedgerInsertResult {
  /** False when the key already existed — `entry` is then the ORIGINAL row. */
  inserted: boolean;
  entry: ConnectorLedgerEntry;
}

export interface ConnectorDataStore {
  getVendor(tenantId: string, vendorId: string): Promise<VendorRecord | null>;
  listVendors(tenantId: string, limit: number): Promise<VendorRecord[]>;
  putVendor(vendor: VendorRecord): Promise<void>;
  getInvoice(tenantId: string, invoiceId: string): Promise<InvoiceRecord | null>;
  getPurchaseOrder(tenantId: string, purchaseOrderId: string): Promise<PurchaseOrderRecord | null>;
  getLedgerEntry(tenantId: string, connectorIdempotencyKey: string): Promise<ConnectorLedgerEntry | null>;
  /**
   * Insert-if-absent on the unique key `(tenant_id, connector_idempotency_key)`.
   * MUST be atomic: `INSERT ... ON CONFLICT DO NOTHING RETURNING *` and, when
   * nothing came back, a follow-up SELECT. An in-memory map or a Redis lock
   * alone is not sufficient (PRD §12.5) — the unique constraint is the guard.
   */
  putLedgerEntryIfAbsent(entry: ConnectorLedgerEntry): Promise<LedgerInsertResult>;
  listLedger(tenantId: string): Promise<ConnectorLedgerEntry[]>;
  recordDispatch(record: ConnectorDispatchRecord): Promise<void>;
  completeDispatch(
    tenantId: string,
    connectorIdempotencyKey: string,
    outcome: string,
    completedAt: Date,
  ): Promise<void>;
  listDispatches(tenantId: string, connectorIdempotencyKey: string): Promise<ConnectorDispatchRecord[]>;
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

/**
 * Everything the broker knows about an event. The sink owns `event_id`,
 * `sequence`, `previous_hash` and `event_hash` (PRD §9.1 requires a per-tenant
 * ordered writer for the hash chain), so the broker does not fabricate them.
 *
 * `payloadRedacted` MUST already have been through `redact()` from
 * `@permitzero/domain`; the broker does that before calling `append`.
 */
export interface AuditSinkEvent {
  tenantId: string;
  actionId: string | null;
  runId: string | null;
  actorType: ActorType;
  actorId: string;
  eventType: string;
  eventTime: Date;
  traceId: string | null;
  policyRevisionId: string | null;
  payloadRedacted: Record<string, unknown>;
}

/**
 * Append-only audit port. Implementations MUST fail loudly: a durable audit
 * write that cannot complete blocks protected writes (invariant 5-9, PRD §12.8)
 * rather than being swallowed.
 */
export interface AuditSink {
  append(event: AuditSinkEvent): Promise<void>;
}

/** Stable event-type names emitted by this package (FR-050). */
export const BrokerAuditEventType = {
  permitIssued: 'permit.issued',
  permitConsumed: 'permit.consumed',
  permitRejected: 'permit.rejected',
  permitRevoked: 'permit.revoked',
  brokerRejected: 'broker.rejected',
  executionIntentRecorded: 'execution.intent_recorded',
  executionDispatched: 'execution.dispatched',
  executionSucceeded: 'execution.succeeded',
  executionFailedRetryable: 'execution.failed_retryable',
  executionFailedTerminal: 'execution.failed_terminal',
  executionUnknownOutcome: 'execution.unknown_outcome',
  executionLateResultIgnored: 'execution.late_result_ignored',
  reconciliationStarted: 'reconciliation.started',
  reconciliationResolved: 'reconciliation.resolved',
  reconciliationManualReview: 'reconciliation.manual_review',
} as const;
export type BrokerAuditEventType =
  (typeof BrokerAuditEventType)[keyof typeof BrokerAuditEventType];
