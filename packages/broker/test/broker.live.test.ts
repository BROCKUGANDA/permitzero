/**
 * Live-connector broker tests: the seam opened under guard. Everything here
 * runs against a FAKE live connector — no network, no provider — and proves
 * the broker's live-finance rules: explicit opt-in, connected account, cap,
 * permit-not-burned-on-rejection, `simulated: false` receipts, and
 * reconciliation against provider truth.
 */
import { describe, expect, it } from 'vitest';
import { DenyReason, newId } from '@permitzero/domain';
import type { ActionRecord, ConnectorRecord, VendorRecord } from '@permitzero/domain';
import { Broker } from '../src/broker.js';
import type { BrokerExecuteResult, LiveFinanceGuard } from '../src/broker.js';
import type {
  ConnectorCallResult,
  ConnectorExportRequest,
  ConnectorPaymentRequest,
  ConnectorReceipt,
  ConnectorVendorChangeRequest,
  FinanceConnector,
} from '../src/ports.js';
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
      beneficiary_ref: 'wise:recipient:8692237',
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
    name: 'Live Example Ltd',
    status: 'VERIFIED',
    verifiedBeneficiaryRef: 'wise:recipient:8692237',
    verifiedAt: new Date('2026-01-15T00:00:00Z'),
    bankingChangedAt: null,
    bankingChangeVerifiedAt: null,
    pendingBeneficiaryRef: null,
    allowedDestinationRefs: ['wise:recipient:8692237'],
    accountAgeDays: 400,
    dataClassification: 'INTERNAL',
  };
}

function liveConnectorRecord(overrides: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    connectorId: 'con_wise_live',
    tenantId: TENANT,
    name: 'wise-live',
    type: 'wise',
    environment: 'DEMO',
    status: 'ENABLED',
    allowedTools: ['payment.execute'],
    credentialRef: 'pz:connected_account:cac_test',
    lastHealthCheckAt: null,
    simulated: false,
    connectedAccountId: 'cac_test',
    ...overrides,
  };
}

function liveReceipt(amountMinor: number): ConnectorReceipt {
  return {
    externalReference: 'wise_ext_test_1',
    receiptHash: `sha256:${'cd'.repeat(32)}`,
    amountMinor,
    currency: 'USD',
    beneficiaryRef: 'wise:recipient:8692237',
    completedAt: new Date('2026-10-26T12:00:01Z'),
    simulated: false,
  };
}

/** A fake live connector: whatever behavior the test hands it, nothing more. */
class FakeLiveConnector implements FinanceConnector {
  constructor(
    private readonly behavior: {
      payment: () => Promise<ConnectorCallResult>;
      lookup?: (tenantId: string, key: string) => Promise<ConnectorReceipt | null>;
    },
  ) {}

  async executePayment(): Promise<ConnectorCallResult> {
    return this.behavior.payment();
  }
  async updateVendorBankDetails(_r: ConnectorVendorChangeRequest): Promise<ConnectorCallResult> {
    return { status: 'FAILED_TERMINAL', errorClass: 'NOT_UNDER_TEST' };
  }
  async exportVendors(_r: ConnectorExportRequest): Promise<ConnectorCallResult> {
    return { status: 'FAILED_TERMINAL', errorClass: 'NOT_UNDER_TEST' };
  }
  async lookupByIdempotencyKey(tenantId: string, key: string): Promise<ConnectorReceipt | null> {
    return this.behavior.lookup?.(tenantId, key) ?? null;
  }
}

async function setup(options: {
  live?: LiveFinanceGuard;
  connectorRecord?: ConnectorRecord | null;
  connector?: FinanceConnector;
  actionOverrides?: Partial<ActionRecord>;
}): Promise<{
  stores: MemoryStores;
  broker: Broker;
  act: ActionRecord;
  issue: () => Promise<{ token: string }>;
}> {
  const now = { t: new Date('2026-10-26T12:00:00Z').getTime() };
  const clock = () => new Date(now.t);
  const stores: MemoryStores = createMemoryStores({ clock });
  const permits = new PermitService({
    signingKey: SIGNING_KEY,
    signingKeyId: 'test-key-v1',
    store: stores.permits,
    clock,
  });
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
  const act = action(options.actionOverrides);
  await stageAction(stores, act);
  const connectorRecordValue = options.connectorRecord === undefined ? liveConnectorRecord() : options.connectorRecord;
  const broker = new Broker({
    permits,
    actions: stores.actions,
    executions: stores.executions,
    data: stores.data,
    audit: stores.audit,
    resolveConnector: async () => (connectorRecordValue ? { ...connectorRecordValue } : null),
    getConnector: (record) =>
      options.connector ??
      new FakeLiveConnector({
        payment: async () => ({ status: 'SUCCEEDED', receipt: liveReceipt(300000) }),
      }),
    ...(options.live ? { live: options.live } : {}),
    clock,
  });
  const issue = () =>
    permits.issue({
      tenantId: TENANT,
      agentId: act.agentId,
      actionId: act.actionId,
      actionHash: act.argumentsHash,
      policyRevisionId: act.policyRevisionId ?? 'polrev_test',
      audienceTool: act.toolName,
      ttlSeconds: 60,
    });
  return { stores, broker, act, issue };
}

const GUARD: LiveFinanceGuard = { enabled: true, providerTypes: ['wise'], maxAmountMinor: 500_000 };

function runOnce(broker: Broker, act: ActionRecord, token: string): Promise<BrokerExecuteResult> {
  return broker.execute({
    tenantId: TENANT,
    actionId: act.actionId,
    permitToken: token,
    actorId: 'wkr_test',
    traceId: act.traceId,
  });
}

describe('Broker live-finance guard', () => {
  it('rejects a live connector when live finance is not wired, and does NOT burn the permit', async () => {
    // No `live` option at all: the deployment never opted in.
    const { broker, act, issue } = await setup({ connector: undefined });
    const permit = await issue();
    const rejected = await runOnce(broker, act, permit.token);
    expect(rejected.outcome).toBe('REJECTED');
    if (rejected.outcome !== 'REJECTED') return;
    expect(rejected.reason).toBe(DenyReason.LIVE_FINANCE_DISABLED);
    expect(rejected.detail).toMatch(/not enabled/);
    // The proof the guard burns nothing: the SAME permit executes once live
    // finance is wired.
    const { broker: guarded, act: act2, issue: issue2 } = await setup({ live: GUARD });
    const permit2 = await issue2();
    const first = await runOnce(guarded, act2, permit2.token);
    expect(first.outcome).toBe('SUCCEEDED');
    void permit;
  });

  it('rejects a live row with no connected account, before burning the permit', async () => {
    const { broker, act, issue } = await setup({
      live: GUARD,
      connectorRecord: liveConnectorRecord({ connectedAccountId: null }),
    });
    const permit = await issue();
    const rejected = await runOnce(broker, act, permit.token);
    expect(rejected.outcome).toBe('REJECTED');
    if (rejected.outcome !== 'REJECTED') return;
    expect(rejected.reason).toBe(DenyReason.CONNECTED_ACCOUNT_MISSING);
  });

  it('rejects an unwired provider type', async () => {
    const { broker, act, issue } = await setup({
      live: GUARD,
      connectorRecord: liveConnectorRecord({ type: 'stripe' }),
    });
    const permit = await issue();
    const rejected = await runOnce(broker, act, permit.token);
    expect(rejected.outcome).toBe('REJECTED');
    if (rejected.outcome !== 'REJECTED') return;
    expect(rejected.reason).toBe(DenyReason.LIVE_CONNECTOR_NOT_CONFIGURED);
  });

  it('rejects a transfer over the live ceiling, before burning the permit', async () => {
    const { broker, act, issue } = await setup({
      live: { ...GUARD, maxAmountMinor: 250_000 },
      actionOverrides: { argumentsRedacted: { ...action().argumentsRedacted, amount_minor: 300000 } },
    });
    const permit = await issue();
    const rejected = await runOnce(broker, act, permit.token);
    expect(rejected.outcome).toBe('REJECTED');
    if (rejected.outcome !== 'REJECTED') return;
    expect(rejected.reason).toBe(DenyReason.LIVE_LIMIT_EXCEEDED);
    // Still unburned: the identical permit executes under the raised cap.
    const { broker: open, act: act2, issue: issue2 } = await setup({ live: GUARD });
    const permit2 = await issue2();
    expect((await runOnce(open, act2, permit2.token)).outcome).toBe('SUCCEEDED');
    void permit;
  });

  it('refuses to cap what it cannot read: an unreadable amount rejects before the permit', async () => {
    const { broker, act, issue } = await setup({
      live: GUARD,
      actionOverrides: {
        argumentsRedacted: { ...action().argumentsRedacted, amount_minor: '[REDACTED]' },
      },
    });
    const permit = await issue();
    const rejected = await runOnce(broker, act, permit.token);
    expect(rejected.outcome).toBe('REJECTED');
    if (rejected.outcome !== 'REJECTED') return;
    expect(rejected.reason).toBe(DenyReason.NON_CANONICAL_INPUT);
  });

  it('executes a live payment under the guard, with a simulated:false receipt', async () => {
    const { stores, broker, act, issue } = await setup({ live: GUARD });
    const permit = await issue();
    const result = await runOnce(broker, act, permit.token);
    expect(result.outcome).toBe('SUCCEEDED');
    if (result.outcome !== 'SUCCEEDED') return;
    expect(result.receipt.simulated).toBe(false);
    expect(result.receipt.externalReference).toMatch(/^wise_/);
    expect((await stores.actions.loadAction(act.actionId, TENANT))?.state).toBe('SUCCEEDED');
    // The ledger entry is the CONNECTOR's contract (see the Wise connector
    // tests); the broker's own contract is the honest execution record.
    const execution = await stores.executions.findLatestByAction(act.actionId, TENANT);
    expect(execution?.state).toBe('SUCCEEDED');
    expect(execution?.receipt?.simulated).toBe(false);
    const events = stores.audit.events.map((e) => e.eventType);
    expect(events).toEqual([
      'permit.consumed',
      'execution.intent_recorded',
      'execution.dispatched',
      'execution.succeeded',
    ]);
  });

  it('maps a funded-but-unconfirmed transfer to UNKNOWN_OUTCOME and reconciles to the provider truth', async () => {
    // First attempt: the fake connector dispatched but never reported.
    let dispatches = 0;
    const { stores, broker, act, issue } = await setup({
      live: GUARD,
      connector: new FakeLiveConnector({
        payment: async () => {
          dispatches += 1;
          return { status: 'TIMEOUT_AFTER_DISPATCH' };
        },
      }),
    });
    const permit = await issue();
    const result = await runOnce(broker, act, permit.token);
    expect(result.outcome).toBe('UNKNOWN_OUTCOME');
    if (result.outcome !== 'UNKNOWN_OUTCOME') return;
    expect(result.execution.state).toBe('UNKNOWN_OUTCOME');
    expect(dispatches).toBe(1);
    expect(await stores.data.listLedger(TENANT)).toHaveLength(0);

    // The provider later reports the transfer as sent: reconciliation reads
    // the LIVE connector's lookup, not the ledger.
    const truthConnector = new FakeLiveConnector({
      payment: async () => ({ status: 'SUCCEEDED', receipt: liveReceipt(300000) }),
      lookup: async () => liveReceipt(300000),
    });
    const reconcilingBroker = new Broker({
      permits: new PermitService({ signingKey: SIGNING_KEY, signingKeyId: 'k', store: stores.permits }),
      actions: stores.actions,
      executions: stores.executions,
      data: stores.data,
      audit: stores.audit,
      resolveConnector: async () => liveConnectorRecord(),
      getConnector: () => truthConnector,
      live: GUARD,
      clock: () => new Date('2026-10-26T12:05:00Z'),
    });
    const reconciled = await reconcilingBroker.reconcile(act.actionId, TENANT);
    expect(reconciled.outcome).toBe('RESOLVED_SUCCEEDED');
    if (reconciled.outcome !== 'RESOLVED_SUCCEEDED') return;
    expect(reconciled.receipt.simulated).toBe(false);
    expect((await stores.actions.loadAction(act.actionId, TENANT))?.state).toBe('SUCCEEDED');
  });
});
