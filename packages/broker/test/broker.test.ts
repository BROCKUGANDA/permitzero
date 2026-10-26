/**
 * Broker tests: the full execute → receipt path, single-flight permit
 * consumption, unknown-outcome reconciliation and every fail-closed branch —
 * all against in-memory stores with a controllable clock.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DenyReason, newId } from '@permitzero/domain';
import type { ActionRecord, ConnectorRecord, VendorRecord } from '@permitzero/domain';
import { Broker } from '../src/broker.js';
import { SimulatedFinanceConnector, clearConnectorFaultProfile, setConnectorFaultProfile } from '../src/connector.js';
import { createMemoryStores, stageAction, stagingFor } from '../src/memory-stores.js';
import type { MemoryStores } from '../src/memory-stores.js';
import { PermitService } from '../src/permits.js';

const TENANT = 'ten_test';
const SIGNING_KEY = 'test-signing-key-0123456789abcdef';
const ACTION_HASH = `sha256:${'ab'.repeat(32)}`;

function action(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    actionId: newId('action'),
    tenantId: TENANT,
    agentId: 'agt_test',
    runId: 'run_test',
    toolName: 'payment.execute',
    operation: 'execute',
    taskPurpose: 'Pay invoice INV-2041',
    argumentsRedacted: {
      invoice_id: 'INV-2041',
      vendor_id: 'VEN-017',
      amount_minor: 300000,
      currency: 'USD',
      beneficiary_ref: 'BEN-017-VERIFIED',
    },
    argumentsHash: ACTION_HASH,
    hashVersion: 'pz-canon-v1',
    evidenceRefs: [],
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    state: 'PERMIT_ISSUED',
    decision: 'ALLOW',
    decisionReasonCodes: ['WITHIN_LIMIT'],
    policyRevisionId: 'polrev_test',
    riskSignals: [],
    requestedAt: new Date('2026-10-26T12:00:00Z'),
    expiresAt: null,
    version: 0,
    environment: 'DEMO',
    requiredApprovals: 0,
    traceId: newId('trace'),
    createdByActorId: 'agt_test',
    createdByActorType: 'AGENT',
    ...overrides,
  };
}

function vendorRecord(): VendorRecord {
  return {
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
}

function connectorRecord(overrides: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    connectorId: 'con_sim',
    tenantId: TENANT,
    name: 'simulated-finance',
    type: 'SIMULATED',
    environment: 'DEMO',
    status: 'ENABLED',
    allowedTools: ['payment.execute', 'vendor.update_bank_details', 'vendor.export'],
    credentialRef: 'secret://sim/test',
    lastHealthCheckAt: null,
    simulated: true,
    ...overrides,
  };
}

async function setup(actionOverrides: Partial<ActionRecord> = {}, connector: ConnectorRecord | null = connectorRecord()) {
  const now = { t: new Date('2026-10-26T12:00:00Z').getTime() };
  const clock = () => new Date(now.t);
  const stores: MemoryStores = createMemoryStores({ clock });
  const permits = new PermitService({ signingKey: SIGNING_KEY, signingKeyId: 'test-key-v1', store: stores.permits, clock });
  await stores.data.putVendor(vendorRecord());
  stagingFor(stores.data).putInvoice({
    invoiceId: 'INV-2041',
    tenantId: TENANT,
    vendorId: 'VEN-017',
    amountMinor: 300000,
    currency: 'USD',
    purchaseOrderId: 'PO-882',
    status: 'OPEN',
    documentText: null,
    untrusted: true,
  });
  const act = action(actionOverrides);
  await stageAction(stores, act);
  const broker = new Broker({
    permits,
    actions: stores.actions,
    executions: stores.executions,
    data: stores.data,
    audit: stores.audit,
    resolveConnector: async () => (connector ? { ...connector } : null),
    getConnector: (record) =>
      new SimulatedFinanceConnector({ connectorId: record.connectorId, credentialRef: record.credentialRef, data: stores.data, clock }),
    clock,
  });
  const issue = (hash = act.argumentsHash) =>
    permits.issue({
      tenantId: TENANT,
      agentId: act.agentId,
      actionId: act.actionId,
      actionHash: hash,
      policyRevisionId: act.policyRevisionId ?? 'polrev_test',
      audienceTool: act.toolName,
      ttlSeconds: 60,
    });
  return { stores, permits, broker, act, issue, clock, advance: (ms: number) => { now.t += ms; } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  clearConnectorFaultProfile();
});

describe('Broker.execute', () => {
  it('executes a payment end to end and records the receipt', async () => {
    const { stores, broker, act, issue } = await setup();
    const permit = await issue();
    const result = await broker.execute({
      tenantId: TENANT,
      actionId: act.actionId,
      permitToken: permit.token,
      actorId: 'wkr_test',
      traceId: act.traceId,
    });
    expect(result.outcome).toBe('SUCCEEDED');
    if (result.outcome !== 'SUCCEEDED') return;
    expect(result.receipt.amountMinor).toBe(300000);
    expect(result.receipt.beneficiaryRef).toBe('BEN-017-VERIFIED');
    expect(result.execution.attemptNumber).toBe(1);
    expect((await stores.actions.loadAction(act.actionId, TENANT))?.state).toBe('SUCCEEDED');
    expect(await stores.data.listLedger(TENANT)).toHaveLength(1);
    const events = stores.audit.events.map((e) => e.eventType);
    expect(events).toEqual([
      'permit.consumed',
      'execution.intent_recorded',
      'execution.dispatched',
      'execution.succeeded',
    ]);
    // Permits are single-use: the spent token never executes again.
    const replay = await broker.execute({
      tenantId: TENANT,
      actionId: act.actionId,
      permitToken: permit.token,
      actorId: 'wkr_test',
      traceId: act.traceId,
    });
    expect(replay.outcome).toBe('REJECTED');
    expect(await stores.data.listLedger(TENANT)).toHaveLength(1);
  });

  it('lets exactly one of two racing permits execute', async () => {
    const { stores, broker, act, issue } = await setup();
    const a = await issue();
    const b = await issue();
    const [ra, rb] = await Promise.all([
      broker.execute({ tenantId: TENANT, actionId: act.actionId, permitToken: a.token, actorId: 'w1', traceId: act.traceId }),
      broker.execute({ tenantId: TENANT, actionId: act.actionId, permitToken: b.token, actorId: 'w2', traceId: act.traceId }),
    ]);
    const outcomes = [ra.outcome, rb.outcome].sort();
    expect(outcomes).toEqual(['REJECTED', 'SUCCEEDED']);
    expect(await stores.data.listLedger(TENANT)).toHaveLength(1);
  });

  it('rejects invalid permits without touching the connector', async () => {
    const { stores, broker, act, issue, advance } = await setup();
    const good = await issue();
    advance(61_000);
    const expired = await broker.execute({
      tenantId: TENANT,
      actionId: act.actionId,
      permitToken: good.token,
      actorId: 'w',
      traceId: act.traceId,
    });
    expect(expired).toMatchObject({ outcome: 'REJECTED', reason: DenyReason.PERMIT_EXPIRED });

    const mismatched = await issue(`sha256:${'ff'.repeat(32)}`);
    const result = await broker.execute({
      tenantId: TENANT,
      actionId: act.actionId,
      permitToken: mismatched.token,
      actorId: 'w',
      traceId: act.traceId,
    });
    expect(result).toMatchObject({ outcome: 'REJECTED', reason: DenyReason.PERMIT_HASH_MISMATCH });
    expect(await stores.data.listLedger(TENANT)).toHaveLength(0);
    expect((await stores.actions.loadAction(act.actionId, TENANT))?.state).toBe('PERMIT_ISSUED');
  });

  it('rejects before consuming when the connector cannot serve', async () => {
    const { stores, broker, act, issue, permits } = await setup({}, connectorRecord({ status: 'DISABLED' }));
    const permit = await issue();
    const result = await broker.execute({
      tenantId: TENANT,
      actionId: act.actionId,
      permitToken: permit.token,
      actorId: 'w',
      traceId: act.traceId,
    });
    expect(result).toMatchObject({ outcome: 'REJECTED', reason: DenyReason.CONNECTOR_DISABLED });
    // Pre-checks burn no permit: the token still verifies afterwards.
    const stillValid = await permits.verifyAndConsume(permit.token, {
      tenantId: TENANT,
      actionId: act.actionId,
      actionHash: act.argumentsHash,
      policyRevisionId: 'polrev_test',
      audienceTool: act.toolName,
      now: new Date('2026-10-26T12:00:00Z'),
    });
    expect(stillValid.ok).toBe(true);
    expect(await stores.data.listLedger(TENANT)).toHaveLength(0);
  });

  it('rejects missing actions and non-issued states', async () => {
    const { broker, issue } = await setup();
    const missing = await broker.execute({
      tenantId: TENANT,
      actionId: newId('action'),
      permitToken: 'pzpt_' + 'A'.repeat(43),
      actorId: 'w',
      traceId: newId('trace'),
    });
    expect(missing).toMatchObject({ outcome: 'REJECTED', reason: DenyReason.RESOURCE_OUT_OF_SCOPE });

    const settled = await setup({ state: 'SUCCEEDED' });
    const permit = await settled.issue();
    const result = await settled.broker.execute({
      tenantId: TENANT,
      actionId: settled.act.actionId,
      permitToken: permit.token,
      actorId: 'w',
      traceId: settled.act.traceId,
    });
    expect(result).toMatchObject({ outcome: 'REJECTED', reason: DenyReason.EXECUTION_STATE_CONFLICT });
    void issue;
  });

  it('maps connector faults to retryable and terminal outcomes', async () => {
    const retryable = await setup();
    setConnectorFaultProfile({ failRetryable: true });
    const permit = await retryable.issue();
    const r1 = await retryable.broker.execute({
      tenantId: TENANT,
      actionId: retryable.act.actionId,
      permitToken: permit.token,
      actorId: 'w',
      traceId: retryable.act.traceId,
    });
    expect(r1.outcome).toBe('FAILED_RETRYABLE');
    if (r1.outcome !== 'FAILED_RETRYABLE') return;
    expect(r1.errorClass).toBe('SIMULATED_RETRYABLE_FAULT');
    expect((await retryable.stores.actions.loadAction(retryable.act.actionId, TENANT))?.state).toBe('FAILED_RETRYABLE');

    clearConnectorFaultProfile();
    const terminal = await setup();
    setConnectorFaultProfile({ failTerminal: true });
    const p2 = await terminal.issue();
    const r2 = await terminal.broker.execute({
      tenantId: TENANT,
      actionId: terminal.act.actionId,
      permitToken: p2.token,
      actorId: 'w',
      traceId: terminal.act.traceId,
    });
    expect(r2.outcome).toBe('FAILED_TERMINAL');
  });

  it('records unknown outcome on timeout-after-dispatch and reconciles to success', async () => {
    const { stores, broker, act, issue } = await setup();
    setConnectorFaultProfile({ timeoutAfterDispatch: true });
    const permit = await issue();
    const result = await broker.execute({
      tenantId: TENANT,
      actionId: act.actionId,
      permitToken: permit.token,
      actorId: 'w',
      traceId: act.traceId,
    });
    expect(result.outcome).toBe('UNKNOWN_OUTCOME');
    expect((await stores.actions.loadAction(act.actionId, TENANT))?.state).toBe('UNKNOWN_OUTCOME');

    clearConnectorFaultProfile();
    const reconciled = await broker.reconcile(act.actionId, TENANT);
    expect(reconciled.outcome).toBe('RESOLVED_SUCCEEDED');
    if (reconciled.outcome !== 'RESOLVED_SUCCEEDED') return;
    expect(reconciled.receipt.amountMinor).toBe(300000);
    expect((await stores.actions.loadAction(act.actionId, TENANT))?.state).toBe('SUCCEEDED');
    // Exactly one effect despite the lost response.
    expect(await stores.data.listLedger(TENANT)).toHaveLength(1);
  });

  it('treats a caller deadline elapse as unknown and ignores the late result', async () => {
    const { stores, broker, act, issue } = await setup();
    setConnectorFaultProfile({ latencyMs: 300 });
    const permit = await issue();
    const result = await broker.execute({
      tenantId: TENANT,
      actionId: act.actionId,
      permitToken: permit.token,
      actorId: 'w',
      traceId: act.traceId,
      deadlineMs: 30,
    });
    expect(result.outcome).toBe('UNKNOWN_OUTCOME');
    await sleep(450);
    const events = stores.audit.events.map((e) => e.eventType);
    expect(events).toContain('execution.late_result_ignored');
    // The late success did not move the action; reconciliation owns that now.
    expect((await stores.actions.loadAction(act.actionId, TENANT))?.state).toBe('UNKNOWN_OUTCOME');
    clearConnectorFaultProfile();
    const reconciled = await broker.reconcile(act.actionId, TENANT);
    expect(reconciled.outcome).toBe('RESOLVED_SUCCEEDED');
  });

  it('fails closed on masked dispatch arguments without dispatching', async () => {
    const { stores, broker, act, issue } = await setup({
      argumentsRedacted: {
        invoice_id: 'INV-2041',
        vendor_id: 'VEN-017',
        amount_minor: 300000,
        currency: 'USD',
        beneficiary_ref: '••••0042',
      },
    });
    const permit = await issue();
    const result = await broker.execute({
      tenantId: TENANT,
      actionId: act.actionId,
      permitToken: permit.token,
      actorId: 'w',
      traceId: act.traceId,
    });
    expect(result).toMatchObject({ outcome: 'FAILED_TERMINAL', errorClass: 'DISPATCH_ARGUMENTS_UNRECOVERABLE' });
    expect(await stores.data.listLedger(TENANT)).toHaveLength(0);
  });

  it('executes vendor bank-detail changes and stages them pending', async () => {
    const { stores, broker, act, issue } = await setup({
      toolName: 'vendor.update_bank_details',
      operation: 'update',
      argumentsRedacted: { vendor_id: 'VEN-017', new_beneficiary_ref: 'BEN-999-NEW', verification_ref: null },
    });
    const permit = await issue();
    const result = await broker.execute({
      tenantId: TENANT,
      actionId: act.actionId,
      permitToken: permit.token,
      actorId: 'w',
      traceId: act.traceId,
    });
    expect(result.outcome).toBe('SUCCEEDED');
    if (result.outcome !== 'SUCCEEDED') return;
    expect(result.receipt.beneficiaryRef).toBe('BEN-999-NEW');
    expect((await stores.data.getVendor(TENANT, 'VEN-017'))?.pendingBeneficiaryRef).toBe('BEN-999-NEW');
  });

  it('fails retryable when the intent write fails, without dispatching', async () => {
    const ctx = await setup();
    const failing = {
      ...ctx.stores.executions,
      recordIntent: async () => {
        throw new Error('db down');
      },
    };
    const broker = new Broker({
      permits: ctx.permits,
      actions: ctx.stores.actions,
      executions: failing,
      data: ctx.stores.data,
      audit: ctx.stores.audit,
      resolveConnector: async () => connectorRecord(),
      getConnector: (record) =>
        new SimulatedFinanceConnector({ connectorId: record.connectorId, credentialRef: record.credentialRef, data: ctx.stores.data, clock: ctx.clock }),
      clock: ctx.clock,
    });
    const permit = await ctx.issue();
    const result = await broker.execute({
      tenantId: TENANT,
      actionId: ctx.act.actionId,
      permitToken: permit.token,
      actorId: 'w',
      traceId: ctx.act.traceId,
    });
    expect(result).toMatchObject({ outcome: 'FAILED_RETRYABLE', errorClass: 'INTENT_WRITE_FAILED' });
    expect(await ctx.stores.data.listLedger(TENANT)).toHaveLength(0);
  });
});

describe('Broker.reconcile', () => {
  it('resolves an effect that never dispatched as failed, terminally', async () => {
    const { stores, broker, act } = await setup();
    // Crash window: intent durable, dispatch never reached the connector.
    await stores.executions.recordIntent({
      executionId: newId('execution'),
      tenantId: TENANT,
      actionId: act.actionId,
      connectorId: 'con_sim',
      attemptNumber: 1,
      connectorIdempotencyKey: 'v1:manual:no-dispatch',
      state: 'UNKNOWN_OUTCOME',
      dispatchStartedAt: new Date('2026-10-26T12:00:00Z'),
      resultReceivedAt: new Date('2026-10-26T12:00:01Z'),
      externalReference: null,
      receiptHash: null,
      errorClass: 'TIMEOUT_AFTER_DISPATCH',
      retryAfterAt: null,
      permitId: null,
      permitNonceHash: null,
      actorId: 'w',
      traceId: act.traceId,
      receipt: null,
      createdAt: new Date('2026-10-26T12:00:00Z'),
      updatedAt: new Date('2026-10-26T12:00:01Z'),
    });
    for (const to of ['EXECUTION_PENDING', 'EXECUTING', 'UNKNOWN_OUTCOME'] as const) {
      const current = await stores.actions.loadAction(act.actionId, TENANT);
      await stores.actions.transitionState({
        actionId: act.actionId,
        tenantId: TENANT,
        to,
        expectedVersion: current?.version ?? 0,
        now: new Date('2026-10-26T12:00:00Z'),
      });
    }
    const result = await broker.reconcile(act.actionId, TENANT);
    expect(result).toMatchObject({ outcome: 'RESOLVED_FAILED', errorClass: 'EFFECT_NEVER_DISPATCHED' });
    expect((await stores.actions.loadAction(act.actionId, TENANT))?.state).toBe('FAILED_TERMINAL');
  });

  it('sends open dispatches without receipts to manual review', async () => {
    const { stores, broker, act } = await setup();
    // The connector started the effect and went silent with no ledger entry:
    // the only safe landing is a human.
    await stores.data.recordDispatch({
      tenantId: TENANT,
      connectorIdempotencyKey: 'v1:manual:open-dispatch',
      operation: 'payment.execute',
      startedAt: new Date('2026-10-26T12:00:00Z'),
      completedAt: null,
      outcome: null,
    });
    await stores.executions.recordIntent({
      executionId: newId('execution'),
      tenantId: TENANT,
      actionId: act.actionId,
      connectorId: 'con_sim',
      attemptNumber: 1,
      connectorIdempotencyKey: 'v1:manual:open-dispatch',
      state: 'UNKNOWN_OUTCOME',
      dispatchStartedAt: new Date('2026-10-26T12:00:00Z'),
      resultReceivedAt: new Date('2026-10-26T12:00:01Z'),
      externalReference: null,
      receiptHash: null,
      errorClass: 'TIMEOUT_AFTER_DISPATCH',
      retryAfterAt: null,
      permitId: null,
      permitNonceHash: null,
      actorId: 'w',
      traceId: act.traceId,
      receipt: null,
      createdAt: new Date('2026-10-26T12:00:00Z'),
      updatedAt: new Date('2026-10-26T12:00:01Z'),
    });
    for (const to of ['EXECUTION_PENDING', 'EXECUTING', 'UNKNOWN_OUTCOME'] as const) {
      const current = await stores.actions.loadAction(act.actionId, TENANT);
      await stores.actions.transitionState({
        actionId: act.actionId,
        tenantId: TENANT,
        to,
        expectedVersion: current?.version ?? 0,
        now: new Date('2026-10-26T12:00:00Z'),
      });
    }
    const result = await broker.reconcile(act.actionId, TENANT);
    expect(result.outcome).toBe('MANUAL_REVIEW');
    expect((await stores.actions.loadAction(act.actionId, TENANT))?.state).toBe('MANUAL_REVIEW');
  });

  it('is idempotent across repeated calls', async () => {
    const { broker, act, issue } = await setup();
    setConnectorFaultProfile({ timeoutAfterDispatch: true });
    const permit = await issue();
    await broker.execute({ tenantId: TENANT, actionId: act.actionId, permitToken: permit.token, actorId: 'w', traceId: act.traceId });
    clearConnectorFaultProfile();
    const first = await broker.reconcile(act.actionId, TENANT);
    const second = await broker.reconcile(act.actionId, TENANT);
    expect(first.outcome).toBe('RESOLVED_SUCCEEDED');
    expect(second.outcome).toBe('RESOLVED_SUCCEEDED');
  });

  it('throws not-found for unknown actions', async () => {
    const { broker } = await setup();
    await expect(broker.reconcile(newId('action'), TENANT)).rejects.toThrow('not found');
  });
});
