/**
 * Execution-layer storage tests: permits, executions, the audit hash chain,
 * the outbox lease protocol, the ledger exactly-once guard, dispatch markers,
 * catalog writes and the database triggers that make dangerous writes fail.
 * Broker-port behavior runs through the durable adapters, not the memory ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DenyReason, newId } from '@permitzero/domain';
import { PermitService } from '@permitzero/broker';
import {
  appendAuditEvent,
  claimOutboxEvents,
  completeDispatch,
  countOutboxByStatus,
  createAction,
  createDbStores,
  findLatestPermitByAction,
  getAction,
  getEnforcementMode,
  getOutboxEvent,
  insertInvoice,
  insertModelEvaluation,
  insertOutboxEvent,
  listAuditEvents,
  listDispatches,
  listRecentModelEvaluations,
  markOutboxDead,
  markOutboxFailed,
  markOutboxPublished,
  putLedgerEntryIfAbsent,
  recordDispatch,
  redriveOutboxEvent,
  seed,
  setConnectorStatus,
  setEnforcementMode,
  transitionAction,
  updateConnectorHealth,
  upsertVendor,
  verifyAuditChain,
  findConnectorForTool,
  getLedgerEntry,
  type Db,
  type SeedResult,
} from '../src/index.js';
import { closeTestDb, resetTestDb, testDb } from './db-test.js';

let db: Db;
let seeded: SeedResult;

const tenantId = () => seeded.tenantIds[0] ?? '';
const agentId = () => seeded.agentIds[0] ?? '';
const ACTION_HASH = `sha256:${'ab'.repeat(32)}`;
/** Fixed clock for transition inputs; the port requires an explicit `now`. */
const NOW = new Date('2026-10-26T12:00:00Z');

beforeAll(async () => {
  db = await testDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  seeded = await seed(db);
});

async function makeAction() {
  return createAction(db.db, {
    actionId: newId('action'),
    tenantId: tenantId(),
    agentId: agentId(),
    runId: 'run_exec_1',
    toolName: 'payment.execute',
    operation: 'execute',
    taskPurpose: 'Execution storage test',
    argumentsRedacted: { amount_minor: 1000 },
    argumentsHash: ACTION_HASH,
    hashVersion: 'pz-canon-v1',
    evidenceRefs: [],
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    requestedAt: new Date('2026-10-26T12:00:00Z'),
    environment: 'DEMO',
    traceId: newId('trace'),
    createdByActorId: agentId(),
    createdByActorType: 'AGENT',
  });
}

function permits() {
  const stores = createDbStores(db);
  return {
    stores,
    service: new PermitService({ signingKey: 'test-signing-key-0123456789abcdef', signingKeyId: 'k1', store: stores.permits }),
  };
}

describe('durable permit store', () => {
  it('issues and consumes through the database', async () => {
    const { service } = permits();
    const action = await makeAction();
    const issued = await service.issue({
      tenantId: tenantId(),
      agentId: agentId(),
      actionId: action.actionId,
      actionHash: ACTION_HASH,
      policyRevisionId: seeded.policyRevisionIds[0] ?? '',
      audienceTool: 'payment.execute',
      ttlSeconds: 60,
    });
    const context = {
      tenantId: tenantId(),
      actionId: action.actionId,
      actionHash: ACTION_HASH,
      policyRevisionId: seeded.policyRevisionIds[0] ?? '',
      audienceTool: 'payment.execute',
      now: new Date('2026-10-26T12:00:01Z'),
    };
    expect((await service.verifyAndConsume(issued.token, context)).ok).toBe(true);
    expect(await service.verifyAndConsume(issued.token, context)).toMatchObject({
      ok: false,
      reason: DenyReason.PERMIT_CONSUMED,
    });
  });

  it('finds the latest permit per action for read models', async () => {
    const { service } = permits();
    const action = await makeAction();
    expect(await findLatestPermitByAction(db.db, tenantId(), action.actionId)).toBeNull();
    const issued = await service.issue({
      tenantId: tenantId(),
      agentId: agentId(),
      actionId: action.actionId,
      actionHash: ACTION_HASH,
      policyRevisionId: seeded.policyRevisionIds[0] ?? '',
      audienceTool: 'payment.execute',
      ttlSeconds: 60,
    });
    const found = await findLatestPermitByAction(db.db, tenantId(), action.actionId);
    expect(found?.permitId).toBe(issued.permitId);
    expect(found?.tokenHash).toBeDefined();
  });

  it('lets exactly one concurrent consumer win', async () => {
    const { service } = permits();
    const action = await makeAction();
    const issued = await service.issue({
      tenantId: tenantId(),
      agentId: agentId(),
      actionId: action.actionId,
      actionHash: ACTION_HASH,
      policyRevisionId: seeded.policyRevisionIds[0] ?? '',
      audienceTool: 'payment.execute',
      ttlSeconds: 60,
    });
    const context = () => ({
      tenantId: tenantId(),
      actionId: action.actionId,
      actionHash: ACTION_HASH,
      policyRevisionId: seeded.policyRevisionIds[0] ?? '',
      audienceTool: 'payment.execute',
      now: new Date('2026-10-26T12:00:01Z'),
    });
    const [a, b] = await Promise.all([
      service.verifyAndConsume(issued.token, context()),
      service.verifyAndConsume(issued.token, context()),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('revokes idempotently and distinguishes tenants', async () => {
    const { service, stores } = permits();
    const action = await makeAction();
    const issued = await service.issue({
      tenantId: tenantId(),
      agentId: agentId(),
      actionId: action.actionId,
      actionHash: ACTION_HASH,
      policyRevisionId: seeded.policyRevisionIds[0] ?? '',
      audienceTool: 'payment.execute',
      ttlSeconds: 60,
    });
    await service.revoke(issued.permitId, tenantId(), 'test hold');
    await service.revoke(issued.permitId, tenantId(), 'test hold again');
    const context = {
      tenantId: tenantId(),
      actionId: action.actionId,
      actionHash: ACTION_HASH,
      policyRevisionId: seeded.policyRevisionIds[0] ?? '',
      audienceTool: 'payment.execute',
      now: new Date('2026-10-26T12:00:01Z'),
    };
    expect(await service.verifyAndConsume(issued.token, context)).toMatchObject({
      ok: false,
      reason: DenyReason.PERMIT_REVOKED,
    });
    // The cross-tenant lookup is optional on the port; the durable store provides it.
    const crossTenant = stores.permits.findByTokenHashCrossTenant;
    expect(crossTenant).toBeDefined();
    expect(await crossTenant?.('0'.repeat(64))).toBeNull();
  });
});

describe('durable execution store', () => {
  it('records intent, dispatch and result in order', async () => {
    const stores = createDbStores(db);
    const action = await makeAction();
    const intent = {
      executionId: newId('execution'),
      tenantId: tenantId(),
      actionId: action.actionId,
      connectorId: seeded.connectorIds[0] ?? '',
      attemptNumber: 1,
      connectorIdempotencyKey: 'v1:test:key-1',
      state: 'INTENT_RECORDED' as const,
      dispatchStartedAt: null,
      resultReceivedAt: null,
      externalReference: null,
      receiptHash: null,
      errorClass: null,
      retryAfterAt: null,
      permitId: null,
      permitNonceHash: null,
      actorId: 'wkr_test',
      traceId: action.traceId,
      receipt: null,
      createdAt: new Date('2026-10-26T12:00:00Z'),
      updatedAt: new Date('2026-10-26T12:00:00Z'),
    };
    await stores.executions.recordIntent(intent);
    await expect(stores.executions.recordIntent(intent)).rejects.toMatchObject({ code: '23505' });
    const dispatched = await stores.executions.markDispatched(intent.executionId, tenantId(), new Date('2026-10-26T12:00:01Z'));
    expect(dispatched?.state).toBe('DISPATCHING');
    const done = await stores.executions.markResult({
      executionId: intent.executionId,
      tenantId: tenantId(),
      state: 'SUCCEEDED',
      resultReceivedAt: new Date('2026-10-26T12:00:02Z'),
      externalReference: 'sim_abc',
    });
    expect(done?.state).toBe('SUCCEEDED');
    expect((await stores.executions.findLatestByAction(action.actionId, tenantId()))?.executionId).toBe(intent.executionId);
    expect((await stores.executions.findByIdempotencyKey('v1:test:key-1', tenantId()))?.executionId).toBe(intent.executionId);
    expect(await stores.executions.listUnknownOutcomes(tenantId())).toHaveLength(0);
  });

  it('transitions actions through the adapter with typed conflicts', async () => {
    const stores = createDbStores(db);
    const action = await makeAction();
    expect((await stores.actions.loadAction(action.actionId, tenantId()))?.state).toBe('RECEIVED');
    const moved = await stores.actions.transitionState({
      tenantId: tenantId(),
      actionId: action.actionId,
      to: 'VALIDATING',
      expectedVersion: 0,
      now: NOW,
    });
    expect(moved.ok).toBe(true);
    const conflict = await stores.actions.transitionState({
      tenantId: tenantId(),
      actionId: action.actionId,
      to: 'EVALUATING',
      expectedVersion: 0,
      now: NOW,
    });
    expect(conflict).toMatchObject({ ok: false, reason: 'VERSION_CONFLICT' });
  });
});

describe('audit hash chain', () => {
  const event = (n: number) => ({
    tenantId: tenantId(),
    actionId: null,
    runId: null,
    actorType: 'SYSTEM' as const,
    actorId: 'system:test',
    eventType: 'system.config_changed',
    eventTime: new Date(`2026-10-26T12:00:0${n}Z`),
    traceId: newId('trace'),
    policyRevisionId: null,
    payload: { n },
  });

  it('assigns dense sequences and verifies the chain', async () => {
    for (const n of [1, 2, 3]) await appendAuditEvent(db.db, event(n));
    const listed = await listAuditEvents(db.db, tenantId(), {}, { limit: 10 });
    expect(listed.rows.map((r) => r.sequence)).toEqual([3, 2, 1]);
    expect(listed.nextCursor).toBeNull();
    const verification = await verifyAuditChain(db.db, tenantId());
    expect(verification).toMatchObject({ checked: 3, chainValid: true, breaks: [] });
  });

  it('serializes concurrent appends into a single chain', async () => {
    await Promise.all([1, 2, 3, 4, 5].map((n) => appendAuditEvent(db.db, event(n))));
    const verification = await verifyAuditChain(db.db, tenantId());
    expect(verification.chainValid).toBe(true);
    expect(verification.checked).toBe(5);
    const sequences = (await listAuditEvents(db.db, tenantId(), {}, { limit: 10 })).rows.map((r) => r.sequence).sort();
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
  });

  it('supports keyed hashes and reports missing keys honestly', async () => {
    await appendAuditEvent(db.db, event(1), { hmacKey: 'test-audit-key' });
    expect((await verifyAuditChain(db.db, tenantId(), { hmacKey: 'test-audit-key' })).chainValid).toBe(true);
    const withoutKey = await verifyAuditChain(db.db, tenantId());
    expect(withoutKey.chainValid).toBe(false);
    expect(withoutKey.breaks[0]?.reason).toContain('no key provided');
  });

  it('refuses updates and deletes via trigger', async () => {
    await appendAuditEvent(db.db, event(1));
    await expect(db.sql`UPDATE audit_events SET event_type = 'x'`).rejects.toMatchObject({ code: '0A000' });
    await expect(db.sql`DELETE FROM audit_events`).rejects.toMatchObject({ code: '0A000' });
  });
});

describe('outbox lease protocol', () => {
  const draft = (eventType: string) => ({
    tenantId: tenantId(),
    aggregateType: 'action',
    aggregateId: 'act_1',
    eventType,
    queueName: 'pz.outbox' as const,
    payload: { action_id: 'act_1' },
  });

  it('claims with a lease so double-claims see nothing', async () => {
    await insertOutboxEvent(db.db, draft('action.submitted'));
    const now = new Date('2026-10-26T12:00:00Z');
    expect(await claimOutboxEvents(db.db, 10, now)).toHaveLength(1);
    expect(await claimOutboxEvents(db.db, 10, now)).toHaveLength(0);
    expect(await countOutboxByStatus(db.db)).toEqual({ PENDING: 1 });
  });

  it('releases leases and retries failures', async () => {
    const row = await insertOutboxEvent(db.db, draft('action.submitted'));
    const now = new Date('2026-10-26T12:00:00Z');
    await claimOutboxEvents(db.db, 10, now);
    expect(await markOutboxFailed(db.db, row.outboxEventId, 'CONNECTOR_TIMEOUT', new Date('2026-10-26T11:00:00Z'))).toBe(true);
    const reclaimed = await claimOutboxEvents(db.db, 10, now);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.attemptCount).toBe(2);
    expect(await markOutboxPublished(db.db, row.outboxEventId, now)).toBe(true);
    expect(await markOutboxPublished(db.db, row.outboxEventId, now)).toBe(false);
    expect(await getOutboxEvent(db.db, row.outboxEventId)).toMatchObject({ status: 'PUBLISHED' });
  });

  it('parks poison rows as dead and redrives them explicitly', async () => {
    const row = await insertOutboxEvent(db.db, draft('action.submitted'));
    expect(await markOutboxDead(db.db, row.outboxEventId, 'SCHEMA_MISMATCH')).toBe(true);
    expect(await claimOutboxEvents(db.db, 10, new Date())).toHaveLength(0);
    expect(await redriveOutboxEvent(db.db, row.outboxEventId)).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    expect(await claimOutboxEvents(db.db, 10, new Date())).toHaveLength(1);
  });
});

describe('ledger, dispatches and catalog', () => {
  it('collapses concurrent identical ledger inserts to the first', async () => {
    const input = {
      tenantId: tenantId(),
      connectorId: seeded.connectorIds[0] ?? '',
      connectorIdempotencyKey: 'key-race-1',
      operation: 'payment.execute',
      externalReference: 'sim_race',
      receipt: { externalReference: 'sim_race', receiptHash: `sha256:${'ee'.repeat(32)}` },
      detailRedacted: {},
      recordedAt: new Date('2026-10-26T12:00:00Z'),
    };
    const [a, b] = await Promise.all([putLedgerEntryIfAbsent(db.db, input), putLedgerEntryIfAbsent(db.db, input)]);
    expect([a.inserted, b.inserted].filter(Boolean)).toHaveLength(1);
    expect(a.entry.receiptJson).toEqual(b.entry.receiptJson);
    expect(await getLedgerEntry(db.db, tenantId(), 'key-race-1')).not.toBeNull();
  });

  it('tracks dispatch markers and completes the latest open one', async () => {
    await recordDispatch(db.db, { tenantId: tenantId(), connectorIdempotencyKey: 'key-d', operation: 'payment.execute', startedAt: new Date('2026-10-26T12:00:00Z') });
    await recordDispatch(db.db, { tenantId: tenantId(), connectorIdempotencyKey: 'key-d', operation: 'payment.execute', startedAt: new Date('2026-10-26T12:01:00Z') });
    await completeDispatch(db.db, tenantId(), 'key-d', 'SUCCEEDED', new Date('2026-10-26T12:02:00Z'));
    const markers = await listDispatches(db.db, tenantId(), 'key-d');
    expect(markers).toHaveLength(2);
    expect(markers.filter((m) => m.completedAt !== null)).toHaveLength(1);
    await completeDispatch(db.db, tenantId(), 'key-missing', 'SUCCEEDED', new Date());
  });

  it('manages connectors, vendors and enforcement modes', async () => {
    expect((await findConnectorForTool(db.db, tenantId(), 'payment.execute'))?.simulated).toBe(true);
    expect(await findConnectorForTool(db.db, tenantId(), 'invoice.read')).toBeNull();
    const connectorId = seeded.connectorIds[0] ?? '';
    await updateConnectorHealth(db.db, tenantId(), connectorId, new Date('2026-10-26T12:00:00Z'));
    await setConnectorStatus(db.db, tenantId(), connectorId, 'DEGRADED');
    await setConnectorStatus(db.db, tenantId(), connectorId, 'ENABLED');

    const vendor = await upsertVendor(db.db, {
      vendorId: 'VEN-017',
      tenantId: tenantId(),
      name: 'SYNTHETIC Example Ltd (renamed)',
      status: 'VERIFIED',
      verifiedBeneficiaryRef: 'BEN-017-VERIFIED',
      verifiedAt: new Date('2026-01-15T00:00:00Z'),
      allowedDestinationRefs: ['BEN-017-VERIFIED'],
      accountAgeDays: 401,
      dataClassification: 'INTERNAL',
    });
    expect(vendor.name).toContain('renamed');

    expect((await getEnforcementMode(db.db, tenantId()))?.mode).toBe('ENFORCED');
    const degraded = await setEnforcementMode(db.db, { tenantId: tenantId(), mode: 'EMERGENCY_STOP', reason: 'drill' });
    expect(degraded.protectedWritesAllowed).toBe(false);
    await expect(
      setEnforcementMode(db.db, { tenantId: tenantId(), mode: 'BOGUS' as 'ENFORCED' }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('records model evaluations', async () => {
    const action = await makeAction();
    await insertModelEvaluation(db.db, {
      evaluationId: newId('modelEvaluation'),
      tenantId: tenantId(),
      actionId: action.actionId,
      provider: 'disabled',
      modelId: 'none',
      promptVersion: 'v1',
      schemaVersion: 'risk-hints.v1',
      inputHash: `sha256:${'ff'.repeat(32)}`,
      status: 'DISABLED',
    });
    expect(await listRecentModelEvaluations(db.db, 10)).toHaveLength(1);
  });

  it('seeds invoices through the catalog', async () => {
    const row = await insertInvoice(db.db, {
      invoiceId: 'INV-TEST-1',
      tenantId: tenantId(),
      vendorId: 'VEN-017',
      amountMinor: 12345n,
      currency: 'USD',
    });
    expect(row.documentUntrusted).toBe(true);
  });
});

describe('database triggers', () => {
  it('freezes published policy revisions', async () => {
    // Content is immutable …
    await expect(
      db.sql`UPDATE policy_revisions SET policy_json = '{}' WHERE status = 'PUBLISHED'`,
    ).rejects.toMatchObject({ code: '0A000' });
    // … while status notes stay editable, by design (0002 §1).
    const noted = await db.sql`UPDATE policy_revisions SET change_reason = 'reviewed' WHERE status = 'PUBLISHED'`;
    expect(noted.count).toBe(1);
  });

  it('freezes published outbox rows', async () => {
    const row = await insertOutboxEvent(db.db, {
      tenantId: tenantId(),
      aggregateType: 'action',
      aggregateId: 'act_1',
      eventType: 'action.submitted',
      queueName: 'pz.outbox',
      payload: {},
    });
    await markOutboxPublished(db.db, row.outboxEventId, new Date());
    await expect(markOutboxFailed(db.db, row.outboxEventId, 'X', new Date())).rejects.toMatchObject({ code: '0A000' });
  });

  it('keeps action updated_at fresh via trigger', async () => {
    const action = await makeAction();
    const before = action.updatedAt.getTime();
    await transitionAction(db.db, { tenantId: tenantId(), actionId: action.actionId, to: 'VALIDATING', expectedVersion: 0, now: NOW });
    const after = await getAction(db.db, tenantId(), action.actionId);
    expect((after?.updatedAt.getTime() ?? 0)).toBeGreaterThanOrEqual(before);
  });
});
