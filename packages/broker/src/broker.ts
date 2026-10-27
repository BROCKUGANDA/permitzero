/**
 * The execution broker: the only code path that can reach a side-effecting
 * connector.
 *
 * Execution order per call:
 *   1. Load the action (tenant-scoped) and require PERMIT_ISSUED state.
 *   2. Resolve and validate the connector (pre-checks burn no permit).
 *   3. Verify and atomically consume the single-use permit.
 *   4. Short-circuit on a prior execution for the same idempotency key.
 *   5. Commit the execution-intent row, then dispatch.
 *   6. Map the connector outcome to execution + action state. Any ambiguity
 *      (timeout, exception, timeout-after-dispatch) becomes UNKNOWN_OUTCOME —
 *      never an assumed failure and never a blind retry.
 *
 * Dispatch parameters come from the stored REDACTED arguments plus
 * authoritative records. Anything masked, missing or mistyped fails the
 * attempt terminally before dispatch: the broker would rather refuse than
 * guess a destination. (Production path for IBAN-shaped refs that redaction
 * masks: rebind exact arguments at execute time and re-verify the hash — a
 * contract change, deliberately not snuck in here.)
 */
import {
  DenyReason,
  IllegalTransitionError,
  NotFoundError,
  allowedTransitions,
  newId,
  redact,
} from '@permitzero/domain';
import type { ActionRecord, ActionState, ConnectorRecord, DenyReason as DenyReasonType } from '@permitzero/domain';
import { BrokerAuditEventType, systemClock } from './ports.js';
import type {
  ActionStore,
  AuditSink,
  AuditSinkEvent,
  Clock,
  ConnectorDataStore,
  ConnectorReceipt,
  ExecutionStore,
  PersistedExecution,
} from './ports.js';
import type { ConnectorCallResult, SimulatedFinanceConnector } from './connector.js';
import { PermitService } from './permits.js';

export interface BrokerExecuteRequest {
  tenantId: string;
  actionId: string;
  permitToken: string;
  actorId: string;
  traceId: string;
  /** Caller deadline. On elapse *after* dispatch the broker records
   * UNKNOWN_OUTCOME instead of assuming failure. */
  deadlineMs?: number;
}

export type BrokerExecuteResult =
  | { outcome: 'SUCCEEDED'; execution: PersistedExecution; receipt: ConnectorReceipt }
  | { outcome: 'UNKNOWN_OUTCOME'; execution: PersistedExecution }
  | { outcome: 'FAILED_RETRYABLE' | 'FAILED_TERMINAL'; execution: PersistedExecution; errorClass: string }
  | { outcome: 'REJECTED'; reason: DenyReasonType; detail: string };

export type ReconciliationResult =
  | { outcome: 'RESOLVED_SUCCEEDED'; execution: PersistedExecution; receipt: ConnectorReceipt }
  | { outcome: 'RESOLVED_FAILED'; execution: PersistedExecution; errorClass: string }
  | { outcome: 'MANUAL_REVIEW'; execution: PersistedExecution; detail: string };

/** Resolves the connector row authorized for a tool. Implemented by the API/db layer. */
export type ConnectorResolver = (tenantId: string, toolName: string) => Promise<ConnectorRecord | null>;

/** Returns the live connector instance for a row. MVP: simulated only. */
export type ConnectorProvider = (record: ConnectorRecord) => SimulatedFinanceConnector;

export interface BrokerDeps {
  permits: PermitService;
  actions: ActionStore;
  executions: ExecutionStore;
  data: ConnectorDataStore;
  audit: AuditSink;
  resolveConnector: ConnectorResolver;
  getConnector: ConnectorProvider;
  clock?: Clock;
}

/** Deterministic per action+args: retries share it, distinct actions never do. */
export function connectorIdempotencyKey(actionId: string, actionHash: string): string | null {
  const match = /^sha256:([a-f0-9]{64})$/.exec(actionHash);
  const body = match?.[1];
  if (!body) return null;
  return `v1:${actionId}:${body.slice(0, 16)}`;
}

const MASKED_MARKERS = ['[REDACTED]', '••', '[TRUNCATED]', '[DEPTH_LIMIT]', '[UNSERIALIZABLE]'];

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (MASKED_MARKERS.some((m) => value.includes(m))) return null;
  return value;
}

function cleanInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function redactedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redact(payload) as Record<string, unknown>;
}

type PaymentParams = {
  tool: 'payment.execute';
  invoiceId: string;
  vendorId: string;
  amountMinor: number;
  currency: string;
  beneficiaryRef: string;
};
type VendorChangeParams = {
  tool: 'vendor.update_bank_details';
  vendorId: string;
  newBeneficiaryRef: string;
  verificationRef: string | null;
};
type ExportParams = {
  tool: 'vendor.export';
  vendorId: string | null;
  recordLimit: number;
  dataClassification: string;
};
type DispatchParams = PaymentParams | VendorChangeParams | ExportParams;

interface DispatchBase {
  tenantId: string;
  connectorId: string;
  idempotencyKey: string;
  actionId: string;
  executionId: string;
  traceId: string;
}

export class Broker {
  private readonly permits: PermitService;
  private readonly actions: ActionStore;
  private readonly executions: ExecutionStore;
  private readonly data: ConnectorDataStore;
  private readonly audit: AuditSink;
  private readonly resolveConnector: ConnectorResolver;
  private readonly getConnector: ConnectorProvider;
  private readonly clock: Clock;

  constructor(deps: BrokerDeps) {
    this.permits = deps.permits;
    this.actions = deps.actions;
    this.executions = deps.executions;
    this.data = deps.data;
    this.audit = deps.audit;
    this.resolveConnector = deps.resolveConnector;
    this.getConnector = deps.getConnector;
    this.clock = deps.clock ?? systemClock;
  }

  async execute(request: BrokerExecuteRequest): Promise<BrokerExecuteResult> {
    const now = this.clock();
    const action = await this.actions.loadAction(request.actionId, request.tenantId);
    if (!action) {
      await this.emit({
        tenantId: request.tenantId,
        actionId: request.actionId,
        runId: null,
        actorType: 'SYSTEM',
        actorId: 'system:broker',
        eventType: BrokerAuditEventType.brokerRejected,
        eventTime: now,
        traceId: request.traceId,
        policyRevisionId: null,
        payloadRedacted: redactedPayload({ reason: DenyReason.RESOURCE_OUT_OF_SCOPE }),
      });
      return {
        outcome: 'REJECTED',
        reason: DenyReason.RESOURCE_OUT_OF_SCOPE,
        detail: 'Action not found in this tenant.',
      };
    }
    if (action.state !== 'PERMIT_ISSUED') {
      return this.reject(
        action,
        request.traceId,
        DenyReason.EXECUTION_STATE_CONFLICT,
        `Action is ${action.state}; only an issued permit can execute. Submit a new action instead of retrying a settled one.`,
      );
    }
    if (!action.policyRevisionId) {
      return this.reject(
        action,
        request.traceId,
        DenyReason.POLICY_MISSING,
        'Action has no evaluated policy revision.',
      );
    }
    const connectorKey = connectorIdempotencyKey(action.actionId, action.argumentsHash);
    if (!connectorKey) {
      return this.reject(
        action,
        request.traceId,
        DenyReason.NON_CANONICAL_INPUT,
        'Stored action hash is malformed; refusing to derive an idempotency key.',
      );
    }

    // Connector pre-checks burn no permit: a flapping connector must not eat
    // single-use permits. (A disable landing mid-flight is an accepted
    // check-then-act race; single-use + ledger idempotency still bound it to
    // at most one effect.)
    const connectorRecord = await this.resolveConnector(request.tenantId, action.toolName);
    if (!connectorRecord) {
      return this.reject(
        action,
        request.traceId,
        DenyReason.CONNECTOR_UNKNOWN,
        `No connector serves ${action.toolName}.`,
      );
    }
    if (connectorRecord.status === 'DISABLED') {
      return this.reject(action, request.traceId, DenyReason.CONNECTOR_DISABLED, 'The connector is disabled.');
    }
    if (connectorRecord.status === 'QUARANTINED') {
      return this.reject(action, request.traceId, DenyReason.CONNECTOR_QUARANTINED, 'The connector is quarantined.');
    }
    if (!connectorRecord.allowedTools.includes(action.toolName)) {
      return this.reject(
        action,
        request.traceId,
        DenyReason.OPERATION_NOT_ALLOWED,
        `The connector does not permit ${action.toolName}.`,
      );
    }
    if (!connectorRecord.simulated) {
      return this.reject(
        action,
        request.traceId,
        DenyReason.CONNECTOR_UNKNOWN,
        'Only simulated connectors are supported in this build.',
      );
    }

    const verified = await this.permits.verifyAndConsume(request.permitToken, {
      tenantId: request.tenantId,
      actionId: action.actionId,
      actionHash: action.argumentsHash,
      policyRevisionId: action.policyRevisionId,
      audienceTool: action.toolName,
      now,
    });
    if (!verified.ok) {
      await this.emitPermitEvent(action, request.traceId, BrokerAuditEventType.permitRejected, {
        reason: verified.reason,
      });
      return { outcome: 'REJECTED', reason: verified.reason, detail: verified.detail };
    }
    await this.emitPermitEvent(action, request.traceId, BrokerAuditEventType.permitConsumed, {
      permit_id: verified.permit.permitId,
    });

    // From here the permit is spent: every path below must land the action in
    // an honest state, never silently.
    let current = action;
    const hop = async (to: ActionState): Promise<boolean> => {
      try {
        const moved = await this.actions.transitionState({
          actionId: current.actionId,
          tenantId: current.tenantId,
          to,
          expectedVersion: current.version,
          now: this.clock(),
        });
        if (!moved.ok) return false;
        current = moved.action;
        return true;
      } catch (err) {
        // A concurrent writer moved the action first: the hop that was legal
        // against our snapshot is illegal now. Every hop here was verified
        // against freshly loaded state, so this is a lost race, not a bug.
        if (err instanceof IllegalTransitionError) return false;
        throw err;
      }
    };

    if (!(await hop('EXECUTION_PENDING'))) {
      return {
        outcome: 'REJECTED',
        reason: DenyReason.EXECUTION_STATE_CONFLICT,
        detail: 'A concurrent execution won this action; this permit is spent.',
      };
    }

    const prior = await this.executions.findByIdempotencyKey(connectorKey, request.tenantId);
    if (prior) {
      const terminal = await this.shortCircuitPrior(current, prior);
      // Only FAILED_RETRYABLE falls through to a fresh attempt below.
      if (terminal) return terminal;
    }

    const attemptNumber = prior ? prior.attemptNumber + 1 : 1;
    const executionId = newId('execution');
    const intent: PersistedExecution = {
      executionId,
      tenantId: request.tenantId,
      actionId: action.actionId,
      connectorId: connectorRecord.connectorId,
      attemptNumber,
      connectorIdempotencyKey: connectorKey,
      state: 'INTENT_RECORDED',
      dispatchStartedAt: null,
      resultReceivedAt: null,
      externalReference: null,
      receiptHash: null,
      errorClass: null,
      retryAfterAt: null,
      permitId: verified.permit.permitId,
      permitNonceHash: verified.permit.nonceHash,
      actorId: request.actorId,
      traceId: request.traceId,
      receipt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.executions.recordIntent(intent);
    } catch {
      await this.walkTo(current, 'FAILED_RETRYABLE');
      await this.emitExecutionEvent(current, request.traceId, BrokerAuditEventType.executionFailedRetryable, {
        error_class: 'INTENT_WRITE_FAILED',
      });
      return {
        outcome: 'FAILED_RETRYABLE',
        execution: { ...intent, state: 'FAILED_RETRYABLE', errorClass: 'INTENT_WRITE_FAILED' },
        errorClass: 'INTENT_WRITE_FAILED',
      };
    }
    await this.emitExecutionEvent(current, request.traceId, BrokerAuditEventType.executionIntentRecorded, {
      execution_id: executionId,
      attempt_number: attemptNumber,
    });

    if (!(await hop('EXECUTING'))) {
      return {
        outcome: 'REJECTED',
        reason: DenyReason.EXECUTION_STATE_CONFLICT,
        detail: 'Action moved concurrently after intent was recorded; reconcile before retrying.',
      };
    }
    await this.executions.markDispatched(executionId, request.tenantId, this.clock());
    await this.emitExecutionEvent(current, request.traceId, BrokerAuditEventType.executionDispatched, {
      execution_id: executionId,
    });

    const params = this.dispatchParams(current);
    if (params === null) {
      return this.finishTerminal(
        current,
        intent,
        request.traceId,
        'FAILED_TERMINAL',
        'DISPATCH_ARGUMENTS_UNRECOVERABLE',
      );
    }
    if (params === 'UNSUPPORTED_TOOL') {
      return this.finishTerminal(current, intent, request.traceId, 'FAILED_TERMINAL', 'UNSUPPORTED_TOOL');
    }

    return this.dispatchWithDeadline(
      this.getConnector(connectorRecord),
      params,
      {
        tenantId: request.tenantId,
        connectorId: connectorRecord.connectorId,
        idempotencyKey: connectorKey,
        actionId: action.actionId,
        executionId,
        traceId: request.traceId,
      },
      intent,
      current,
      request.traceId,
      request.deadlineMs,
    );
  }

  /**
   * Reconcile an UNKNOWN_OUTCOME execution against connector truth. Never
   * dispatches: it only reads the ledger and dispatch markers, then lands the
   * action in SUCCEEDED, FAILED_TERMINAL or MANUAL_REVIEW.
   */
  async reconcile(actionId: string, tenantId: string): Promise<ReconciliationResult> {
    const action = await this.actions.loadAction(actionId, tenantId);
    if (!action) throw new NotFoundError('Action not found or not accessible.');
    const latest = await this.executions.findLatestByAction(actionId, tenantId);
    if (!latest) throw new Error(`invariant violated: action ${actionId} has no executions`);

    const traceId = latest.traceId;
    if (latest.state !== 'UNKNOWN_OUTCOME') {
      return this.settleNonUnknown(action, latest, traceId);
    }

    const moved = await this.walkTo(action, 'RECONCILING');
    const reconciling = moved ?? (await this.actions.loadAction(actionId, tenantId)) ?? action;
    await this.emitExecutionEvent(reconciling, traceId, BrokerAuditEventType.reconciliationStarted, {
      execution_id: latest.executionId,
    });

    const connectorRecord = await this.resolveConnector(tenantId, reconciling.toolName);
    if (!connectorRecord || !connectorRecord.simulated) {
      return this.manualReview(reconciling, latest, traceId, 'Connector unavailable during reconciliation.');
    }
    const receipt = await this.getConnector(connectorRecord).lookupByIdempotencyKey(
      tenantId,
      latest.connectorIdempotencyKey,
    );
    if (receipt) {
      const resolved =
        (await this.executions.markResult({
          executionId: latest.executionId,
          tenantId,
          state: 'RECONCILED_SUCCEEDED',
          resultReceivedAt: this.clock(),
          externalReference: receipt.externalReference,
          receiptHash: receipt.receiptHash,
          receipt,
        })) ?? latest;
      await this.walkTo(reconciling, 'SUCCEEDED');
      await this.emitExecutionEvent(reconciling, traceId, BrokerAuditEventType.reconciliationResolved, {
        execution_id: latest.executionId,
        outcome: 'SUCCEEDED',
      });
      return { outcome: 'RESOLVED_SUCCEEDED', execution: resolved, receipt };
    }

    const dispatches = await this.data.listDispatches(tenantId, latest.connectorIdempotencyKey);
    if (dispatches.some((d) => d.completedAt === null)) {
      return this.manualReview(
        reconciling,
        latest,
        traceId,
        'The connector started the effect but never reported an outcome.',
      );
    }
    const errorClass = dispatches.length > 0 ? 'EFFECT_DISPATCHED_NO_RECEIPT' : 'EFFECT_NEVER_DISPATCHED';
    const resolved =
      (await this.executions.markResult({
        executionId: latest.executionId,
        tenantId,
        state: 'RECONCILED_FAILED',
        resultReceivedAt: this.clock(),
        errorClass,
      })) ?? latest;
    await this.walkTo(reconciling, 'FAILED_TERMINAL');
    await this.emitExecutionEvent(reconciling, traceId, BrokerAuditEventType.reconciliationResolved, {
      execution_id: latest.executionId,
      outcome: 'FAILED',
      error_class: errorClass,
    });
    return { outcome: 'RESOLVED_FAILED', execution: resolved, errorClass };
  }

  // -- internals -----------------------------------------------------------

  private async reject(
    action: ActionRecord,
    traceId: string,
    reason: DenyReasonType,
    detail: string,
  ): Promise<BrokerExecuteResult> {
    await this.emit({
      tenantId: action.tenantId,
      actionId: action.actionId,
      runId: action.runId,
      actorType: 'SYSTEM',
      actorId: 'system:broker',
      eventType: BrokerAuditEventType.brokerRejected,
      eventTime: this.clock(),
      traceId,
      policyRevisionId: action.policyRevisionId,
      payloadRedacted: redactedPayload({ reason }),
    });
    return { outcome: 'REJECTED', reason, detail };
  }

  /** Prior execution for the same key: terminal truth wins, unknown stays unknown. */
  private async shortCircuitPrior(
    action: ActionRecord,
    prior: PersistedExecution,
  ): Promise<BrokerExecuteResult | null> {
    switch (prior.state) {
      case 'SUCCEEDED':
      case 'RECONCILED_SUCCEEDED': {
        if (!prior.receipt) return null;
        await this.walkTo(action, 'SUCCEEDED');
        return { outcome: 'SUCCEEDED', execution: prior, receipt: prior.receipt };
      }
      case 'UNKNOWN_OUTCOME':
      case 'INTENT_RECORDED':
      case 'DISPATCHING':
        return { outcome: 'UNKNOWN_OUTCOME', execution: prior };
      case 'RECONCILED_FAILED':
      case 'MANUAL_REVIEW':
      case 'FAILED_TERMINAL':
        // A previous attempt already resolved terminally; only a new action retries.
        await this.walkTo(action, prior.state === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW' : 'FAILED_TERMINAL');
        return {
          outcome: 'REJECTED',
          reason: DenyReason.EXECUTION_STATE_CONFLICT,
          detail: 'A previous attempt already resolved; submit a new action instead of re-executing.',
        };
      case 'FAILED_RETRYABLE':
        return null;
    }
  }

  /** Dispatch parameters from stored redacted arguments; null when masked or malformed. */
  private dispatchParams(action: ActionRecord): DispatchParams | 'UNSUPPORTED_TOOL' | null {
    const args = action.argumentsRedacted;
    switch (action.toolName) {
      case 'payment.execute': {
        const invoiceId = cleanString(args['invoice_id']);
        const vendorId = cleanString(args['vendor_id']);
        const amountMinor = cleanInt(args['amount_minor']);
        const currency = cleanString(args['currency']);
        const beneficiaryRef = cleanString(args['beneficiary_ref']);
        if (!invoiceId || !vendorId || amountMinor === null || !currency || !beneficiaryRef) return null;
        return { tool: 'payment.execute', invoiceId, vendorId, amountMinor, currency, beneficiaryRef };
      }
      case 'vendor.update_bank_details': {
        const vendorId = cleanString(args['vendor_id']);
        const newBeneficiaryRef = cleanString(args['new_beneficiary_ref']);
        if (!vendorId || !newBeneficiaryRef) return null;
        const rawVerification = args['verification_ref'];
        const verificationRef =
          rawVerification === null || rawVerification === undefined ? null : cleanString(rawVerification);
        if (rawVerification !== null && rawVerification !== undefined && verificationRef === null) return null;
        return { tool: 'vendor.update_bank_details', vendorId, newBeneficiaryRef, verificationRef };
      }
      case 'vendor.export': {
        const rawVendor = args['vendor_id'];
        const vendorId = rawVendor === null || rawVendor === undefined ? null : cleanString(rawVendor);
        if (rawVendor !== null && rawVendor !== undefined && vendorId === null) return null;
        // `record_limit` aliases to the policy field `arguments.record_count`.
        const recordLimit = cleanInt(args['record_limit']) ?? cleanInt(args['record_count']);
        const dataClassification = cleanString(args['data_classification']);
        if (recordLimit === null || !dataClassification) return null;
        return { tool: 'vendor.export', vendorId, recordLimit, dataClassification };
      }
      default:
        return 'UNSUPPORTED_TOOL';
    }
  }

  private async dispatchWithDeadline(
    connector: SimulatedFinanceConnector,
    params: DispatchParams,
    base: DispatchBase,
    intent: PersistedExecution,
    action: ActionRecord,
    traceId: string,
    deadlineMs: number | undefined,
  ): Promise<BrokerExecuteResult> {
    const call = (async (): Promise<ConnectorCallResult> => {
      try {
        if (params.tool === 'payment.execute') {
          return await connector.executePayment({
            tenantId: base.tenantId,
            connectorId: base.connectorId,
            idempotencyKey: base.idempotencyKey,
            invoiceId: params.invoiceId,
            vendorId: params.vendorId,
            amountMinor: params.amountMinor,
            currency: params.currency,
            beneficiaryRef: params.beneficiaryRef,
            actionId: base.actionId,
            executionId: base.executionId,
            traceId: base.traceId,
          });
        }
        if (params.tool === 'vendor.update_bank_details') {
          return await connector.updateVendorBankDetails({
            tenantId: base.tenantId,
            connectorId: base.connectorId,
            idempotencyKey: base.idempotencyKey,
            vendorId: params.vendorId,
            newBeneficiaryRef: params.newBeneficiaryRef,
            verificationRef: params.verificationRef,
            actionId: base.actionId,
            executionId: base.executionId,
            traceId: base.traceId,
          });
        }
        return await connector.exportVendors({
          tenantId: base.tenantId,
          connectorId: base.connectorId,
          idempotencyKey: base.idempotencyKey,
          vendorId: params.vendorId,
          recordLimit: params.recordLimit,
          dataClassification: params.dataClassification,
          actionId: base.actionId,
          executionId: base.executionId,
          traceId: base.traceId,
        });
      } catch {
        // A throwing connector is indistinguishable from a crash after
        // dispatch: unknown, never assumed failed.
        return { status: 'TIMEOUT_AFTER_DISPATCH' };
      }
    })();

    let timedOut = false;
    let finished = false;
    const noteLateResult = () => {
      if (!finished && timedOut) {
        void this.emitExecutionEvent(action, traceId, BrokerAuditEventType.executionLateResultIgnored, {
          execution_id: intent.executionId,
        });
      }
    };
    void call.then(noteLateResult, noteLateResult);

    let result: ConnectorCallResult | 'TIMEOUT';
    if (deadlineMs === undefined) {
      result = await call;
      finished = true;
    } else {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        result = await new Promise<ConnectorCallResult | 'TIMEOUT'>((resolve) => {
          timer = setTimeout(() => resolve('TIMEOUT'), Math.max(0, deadlineMs));
          void call.then(
            (r) => resolve(r),
            () => resolve({ status: 'TIMEOUT_AFTER_DISPATCH' }),
          );
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result === 'TIMEOUT') {
        timedOut = true;
      } else {
        finished = true;
      }
    }

    if (result === 'TIMEOUT' || result.status === 'TIMEOUT_AFTER_DISPATCH') {
      const updated = (await this.executions.markResult({
        executionId: intent.executionId,
        tenantId: intent.tenantId,
        state: 'UNKNOWN_OUTCOME',
        resultReceivedAt: this.clock(),
        errorClass: 'TIMEOUT_AFTER_DISPATCH',
      })) ?? { ...intent, state: 'UNKNOWN_OUTCOME' as const };
      await this.walkTo(action, 'UNKNOWN_OUTCOME');
      await this.emitExecutionEvent(action, traceId, BrokerAuditEventType.executionUnknownOutcome, {
        execution_id: intent.executionId,
      });
      return { outcome: 'UNKNOWN_OUTCOME', execution: updated };
    }
    if (result.status === 'SUCCEEDED') {
      const updated = (await this.executions.markResult({
        executionId: intent.executionId,
        tenantId: intent.tenantId,
        state: 'SUCCEEDED',
        resultReceivedAt: this.clock(),
        externalReference: result.receipt.externalReference,
        receiptHash: result.receipt.receiptHash,
        receipt: result.receipt,
      })) ?? {
        ...intent,
        state: 'SUCCEEDED' as const,
        receipt: result.receipt,
        externalReference: result.receipt.externalReference,
        receiptHash: result.receipt.receiptHash,
      };
      await this.walkTo(action, 'SUCCEEDED');
      await this.emitExecutionEvent(action, traceId, BrokerAuditEventType.executionSucceeded, {
        execution_id: intent.executionId,
        external_reference: result.receipt.externalReference,
      });
      return { outcome: 'SUCCEEDED', execution: updated, receipt: result.receipt };
    }
    return this.finishTerminal(
      action,
      intent,
      traceId,
      result.status === 'FAILED_RETRYABLE' ? 'FAILED_RETRYABLE' : 'FAILED_TERMINAL',
      result.errorClass,
    );
  }

  private async finishTerminal(
    action: ActionRecord,
    intent: PersistedExecution,
    traceId: string,
    state: 'FAILED_RETRYABLE' | 'FAILED_TERMINAL',
    errorClass: string,
  ): Promise<BrokerExecuteResult> {
    const updated = (await this.executions.markResult({
      executionId: intent.executionId,
      tenantId: intent.tenantId,
      state,
      resultReceivedAt: this.clock(),
      errorClass,
    })) ?? { ...intent, state, errorClass };
    await this.walkTo(action, state);
    await this.emitExecutionEvent(
      action,
      traceId,
      state === 'FAILED_RETRYABLE'
        ? BrokerAuditEventType.executionFailedRetryable
        : BrokerAuditEventType.executionFailedTerminal,
      { execution_id: intent.executionId, error_class: errorClass },
    );
    return { outcome: state, execution: updated, errorClass };
  }

  private async settleNonUnknown(
    action: ActionRecord,
    latest: PersistedExecution,
    traceId: string,
  ): Promise<ReconciliationResult> {
    switch (latest.state) {
      case 'SUCCEEDED':
      case 'RECONCILED_SUCCEEDED': {
        // Crash window: receipt durable, action hop lost. Complete the action.
        await this.walkTo(action, 'SUCCEEDED');
        if (latest.receipt) return { outcome: 'RESOLVED_SUCCEEDED', execution: latest, receipt: latest.receipt };
        return this.manualReview(action, latest, traceId, 'Terminal success is missing its receipt.');
      }
      case 'FAILED_RETRYABLE':
        await this.walkTo(action, 'FAILED_RETRYABLE');
        return { outcome: 'RESOLVED_FAILED', execution: latest, errorClass: latest.errorClass ?? 'UNKNOWN' };
      case 'FAILED_TERMINAL':
      case 'RECONCILED_FAILED':
        await this.walkTo(action, 'FAILED_TERMINAL');
        return { outcome: 'RESOLVED_FAILED', execution: latest, errorClass: latest.errorClass ?? 'UNKNOWN' };
      case 'MANUAL_REVIEW':
        await this.walkTo(action, 'MANUAL_REVIEW');
        return { outcome: 'MANUAL_REVIEW', execution: latest, detail: 'Already awaiting manual review.' };
      case 'INTENT_RECORDED':
      case 'DISPATCHING':
        return this.manualReview(action, latest, traceId, 'Execution started but never completed dispatch.');
      case 'UNKNOWN_OUTCOME':
        throw new Error('unreachable: unknown outcomes reconcile through the ledger path above');
    }
  }

  private async manualReview(
    action: ActionRecord,
    execution: PersistedExecution,
    traceId: string,
    detail: string,
  ): Promise<ReconciliationResult> {
    const updated =
      (await this.executions.markResult({
        executionId: execution.executionId,
        tenantId: execution.tenantId,
        state: 'MANUAL_REVIEW',
        resultReceivedAt: this.clock(),
      })) ?? execution;
    await this.walkTo(action, 'MANUAL_REVIEW');
    await this.emitExecutionEvent(action, traceId, BrokerAuditEventType.reconciliationManualReview, {
      execution_id: execution.executionId,
    });
    return { outcome: 'MANUAL_REVIEW', execution: updated, detail };
  }

  /**
   * Walk an action to a target state along legal hops (BFS, never through
   * QUARANTINED). Used where crash windows leave the action behind the
   * execution: EXECUTING→SUCCEEDED completes directly, while
   * EXECUTION_PENDING→SUCCEEDED routes via EXECUTING. Returns null when no
   * legal path exists or a concurrent writer wins a hop.
   */
  private async walkTo(action: ActionRecord, target: ActionState): Promise<ActionRecord | null> {
    if (action.state === target) return action;
    const prev = new Map<ActionState, ActionState | null>([[action.state, null]]);
    const queue: ActionState[] = [action.state];
    while (queue.length > 0) {
      const from = queue.shift();
      if (!from) break;
      for (const next of allowedTransitions(from)) {
        if (next === 'QUARANTINED' || prev.has(next)) continue;
        prev.set(next, from);
        if (next === target) {
          queue.length = 0;
          break;
        }
        queue.push(next);
      }
    }
    if (!prev.has(target)) return null;
    const path: ActionState[] = [];
    for (let at: ActionState | null = target; at !== null; at = prev.get(at) ?? null) {
      path.unshift(at);
      if (at === action.state) break;
    }
    let current = action;
    for (const to of path.slice(1)) {
      try {
        const moved = await this.actions.transitionState({
          actionId: current.actionId,
          tenantId: current.tenantId,
          to,
          expectedVersion: current.version,
          expectedFrom: current.state,
          now: this.clock(),
        });
        if (!moved.ok) return null;
        current = moved.action;
      } catch (err) {
        if (err instanceof IllegalTransitionError) return null;
        throw err;
      }
    }
    return current;
  }

  private async emitPermitEvent(
    action: ActionRecord,
    traceId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.emit({
      tenantId: action.tenantId,
      actionId: action.actionId,
      runId: action.runId,
      actorType: 'SYSTEM',
      actorId: 'system:broker',
      eventType,
      eventTime: this.clock(),
      traceId,
      policyRevisionId: action.policyRevisionId,
      payloadRedacted: redactedPayload(payload),
    });
  }

  private async emitExecutionEvent(
    action: ActionRecord,
    traceId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.emitPermitEvent(action, traceId, eventType, payload);
  }

  private async emit(event: AuditSinkEvent): Promise<void> {
    await this.audit.append(event);
  }
}
