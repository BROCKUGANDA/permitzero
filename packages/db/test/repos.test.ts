/**
 * Repository tests: identity, policies, actions, approvals and idempotency —
 * against a real migrated PostgreSQL database, reset between tests.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IllegalTransitionError, newId } from '@permitzero/domain';
import type { ActionState } from '@permitzero/domain';
import {
  completeIdempotencyRecord,
  countActionsInRun,
  countAgentActionsSince,
  countOutboxByStatus,
  createAction,
  createApproval,
  createCredential,
  createIdempotencyRecord,
  createRevision,
  failIdempotencyRecord,
  findCredentialBySecretHash,
  findIdempotencyRecord,
  getAction,
  getActionByIdempotency,
  getAgent,
  getMembership,
  getPublishedRevision,
  getTenantBySlug,
  getUserById,
  listActions,
  listApprovalsByAction,
  listExpiredApprovalActions,
  listPolicies,
  listRevisions,
  publishRevision,
  revokeCredential,
  seed,
  setActionDecisionExtras,
  sumSucceededPaymentsSince,
  transitionAction,
  type Db,
  type SeedResult,
} from '../src/index.js';
import { closeTestDb, resetTestDb, testDb } from './db-test.js';
import { isSqlstate } from './sqlstate.js';

let db: Db;
let seeded: SeedResult;

function tenantId(): string {
  const id = seeded.tenantIds[0];
  if (!id) throw new Error('seed produced no tenant');
  return id;
}

function agentId(): string {
  const id = seeded.agentIds[0];
  if (!id) throw new Error('seed produced no agent');
  return id;
}

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

async function makeAction(overrides: Record<string, unknown> = {}) {
  return createAction(db.db, {
    actionId: newId('action'),
    tenantId: tenantId(),
    agentId: agentId(),
    runId: 'run_test_1',
    toolName: 'payment.execute',
    operation: 'execute',
    taskPurpose: 'Test payment',
    argumentsRedacted: { amount_minor: 1000, currency: 'USD' },
    argumentsHash: `sha256:${'ab'.repeat(32)}`,
    hashVersion: 'pz-canon-v1',
    evidenceRefs: [],
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    requestedAt: new Date('2026-10-26T12:00:00Z'),
    environment: 'DEMO',
    traceId: newId('trace'),
    createdByActorId: agentId(),
    createdByActorType: 'AGENT',
    ...overrides,
  } as Parameters<typeof createAction>[1]);
}

async function walkAction(actionId: string, states: ActionState[]): Promise<void> {
  for (const to of states) {
    const current = await getAction(db.db, tenantId(), actionId);
    const moved = await transitionAction(db.db, {
      tenantId: tenantId(),
      actionId,
      to,
      expectedVersion: current?.version ?? 0,
      now: NOW,
    });
    expect(moved.ok).toBe(true);
  }
}

describe('identity repositories', () => {
  it('reads back the seeded tenant, users, memberships and agent', async () => {
    expect((await getTenantBySlug(db.db, 'demo'))?.synthetic).toBe(true);
    const ownerId = seeded.userIds['owner'];
    expect((await getUserById(db.db, ownerId ?? ''))?.email).toContain('owner');
    expect((await getMembership(db.db, tenantId(), ownerId ?? ''))?.role).toBe('OWNER');
    expect((await getAgent(db.db, tenantId(), agentId()))?.status).toBe('ACTIVE');
  });

  it('resolves credentials by secret hash and revokes them', async () => {
    const token = seeded.agentTokens[agentId()] ?? '';
    const hash = createHash('sha256').update(token, 'utf8').digest('hex');
    const found = await findCredentialBySecretHash(db.db, hash);
    expect(found?.subjectType).toBe('AGENT');
    expect(await findCredentialBySecretHash(db.db, '0'.repeat(64))).toBeNull();
    await revokeCredential(db.db, tenantId(), found?.credentialId ?? '', new Date());
    const revoked = await findCredentialBySecretHash(db.db, hash);
    expect(revoked?.status).toBe('REVOKED');
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it('rejects duplicate credential names per tenant', async () => {
    await expect(
      createCredential(db.db, {
        id: newId('credential'),
        tenantId: tenantId(),
        name: 'worker',
        subjectType: 'SERVICE',
        subjectId: null,
        credentialRef: 'secret://x',
        secretHash: '1'.repeat(64),
        secretPrefix: 'pz_test',
        scopes: [],
      }),
    ).rejects.toSatisfy(isSqlstate('23505'));
  });
});

describe('policy repositories', () => {
  it('publishes revisions atomically and guards the head', async () => {
    const policies = await listPolicies(db.db, tenantId());
    expect(policies).toHaveLength(1);
    const policyId = policies[0]?.policyId ?? '';
    expect((await getPublishedRevision(db.db, tenantId(), policyId))?.revisionNumber).toBe(1);

    const rev2 = await createRevision(db.db, {
      id: newId('policyRevision'),
      tenantId: tenantId(),
      policyId,
      document: { schema_version: 'policy.v1', default_effect: 'DENY', rules: [] },
      policyHash: `sha256:${'cc'.repeat(32)}`,
      changeReason: 'test',
    });
    expect(rev2.revisionNumber).toBe(2);
    expect(await listRevisions(db.db, tenantId(), policyId)).toHaveLength(2);

    // Stale pointer: someone else published first.
    await expect(
      publishRevision(db.db, {
        tenantId: tenantId(),
        policyId,
        revisionId: rev2.revisionId,
        expectedCurrentRevisionId: 'polrev_stale',
      }),
    ).rejects.toThrow('changed underneath');
    const head = await getPublishedRevision(db.db, tenantId(), policyId);
    const published = await publishRevision(db.db, {
      tenantId: tenantId(),
      policyId,
      revisionId: rev2.revisionId,
      expectedCurrentRevisionId: head?.revisionId ?? null,
    });
    expect(published.revision.status).toBe('PUBLISHED');
    expect((await getPublishedRevision(db.db, tenantId(), policyId))?.revisionId).toBe(rev2.revisionId);

    // The old head rolled back and cannot publish again.
    await expect(
      publishRevision(db.db, {
        tenantId: tenantId(),
        policyId,
        revisionId: head?.revisionId ?? '',
        expectedCurrentRevisionId: rev2.revisionId,
      }),
    ).rejects.toThrow('Only draft or ready revisions');
  });
});

describe('action repositories', () => {
  it('creates, loads and pages actions with filters', async () => {
    const a = await makeAction({
      toolName: 'payment.execute',
      argumentsRedacted: { amount_minor: 5000, vendor_id: 'VEN-017' },
    });
    await makeAction({ toolName: 'invoice.read', argumentsRedacted: { invoice_id: 'INV-1' } });
    expect((await getAction(db.db, tenantId(), a.actionId))?.state).toBe('RECEIVED');
    expect(await getActionByIdempotency(db.db, tenantId(), agentId(), 'nope')).toBeNull();

    const payments = await listActions(db.db, tenantId(), { toolName: 'payment.execute' }, { limit: 10 });
    expect(payments.rows).toHaveLength(1);
    expect(payments.nextCursor).toBeNull();
    expect(await listActions(db.db, tenantId(), { vendorId: 'VEN-017' }, { limit: 10 })).toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ actionId: a.actionId })]),
    });
    expect((await listActions(db.db, tenantId(), { minAmountMinor: 6000 }, { limit: 10 })).rows).toHaveLength(0);

    const first = await listActions(db.db, tenantId(), {}, { limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await listActions(db.db, tenantId(), {}, { limit: 1, cursor: first.nextCursor });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.actionId).not.toBe(first.rows[0]?.actionId);
    expect(second.nextCursor).toBeNull();
  });

  it('transitions with compare-and-swap and typed conflicts', async () => {
    const a = await makeAction();
    const moved = await transitionAction(db.db, {
      tenantId: tenantId(),
      actionId: a.actionId,
      to: 'VALIDATING',
      expectedVersion: 0,
      now: NOW,
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.action.version).toBe(1);

    const stale = await transitionAction(db.db, {
      tenantId: tenantId(),
      actionId: a.actionId,
      to: 'EVALUATING',
      expectedVersion: 0,
      now: NOW,
    });
    expect(stale).toMatchObject({ ok: false, reason: 'VERSION_CONFLICT', expectedVersion: 0, actualVersion: 1 });

    const mismatch = await transitionAction(db.db, {
      tenantId: tenantId(),
      actionId: a.actionId,
      to: 'EVALUATING',
      expectedVersion: 1,
      expectedFrom: 'EVALUATING',
      now: NOW,
    });
    expect(mismatch).toMatchObject({ ok: false, reason: 'STATE_MISMATCH' });

    const missing = await transitionAction(db.db, {
      tenantId: tenantId(),
      actionId: newId('action'),
      to: 'VALIDATING',
      expectedVersion: 0,
      now: NOW,
    });
    expect(missing).toMatchObject({ ok: false, reason: 'NOT_FOUND' });

    await expect(
      transitionAction(db.db, {
        tenantId: tenantId(),
        actionId: a.actionId,
        to: 'SUCCEEDED',
        expectedVersion: 1,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('persists decision extras alongside transitions', async () => {
    const a = await makeAction();
    await walkAction(a.actionId, ['VALIDATING', 'EVALUATING']);
    await transitionAction(db.db, {
      tenantId: tenantId(),
      actionId: a.actionId,
      to: 'APPROVAL_REQUIRED',
      expectedVersion: 2,
      now: NOW,
      patch: { decision: 'REQUIRE_APPROVAL', decisionReasonCodes: ['AMOUNT_OVER_APPROVAL_THRESHOLD'] },
    });
    await setActionDecisionExtras(db.db, { tenantId: tenantId(), actionId: a.actionId, requiredApprovals: 2 });
    const reloaded = await getAction(db.db, tenantId(), a.actionId);
    expect(reloaded?.decision).toBe('REQUIRE_APPROVAL');
    expect(reloaded?.requiredApprovals).toBe(2);
  });

  it('lists lapsed approval windows oldest first', async () => {
    const past = new Date('2026-10-26T11:00:00Z');
    const future = new Date('2026-10-26T13:00:00Z');
    const mk = async (expiresAt: Date) => {
      const a = await makeAction();
      await walkAction(a.actionId, ['VALIDATING', 'EVALUATING']);
      await transitionAction(db.db, {
        tenantId: tenantId(),
        actionId: a.actionId,
        to: 'APPROVAL_REQUIRED',
        expectedVersion: 2,
        now: NOW,
        patch: { decision: 'REQUIRE_APPROVAL', decisionReasonCodes: [], expiresAt },
      });
      return a.actionId;
    };
    const freshId = await mk(future);
    const staleId = await mk(past);
    // Decided actions never appear even with a past expiry.
    const decidedId = await mk(past);
    await transitionAction(db.db, {
      tenantId: tenantId(),
      actionId: decidedId,
      to: 'REJECTED',
      expectedVersion: 3,
      now: NOW,
    });
    const expired = await listExpiredApprovalActions(db.db, tenantId(), NOW, 10);
    expect(expired.map((r) => r.actionId)).toEqual([staleId]);
    expect(expired.map((r) => r.actionId)).not.toContain(freshId);
  });

  it('counts velocity and budget spend', async () => {
    expect(await countAgentActionsSince(db.db, tenantId(), agentId(), new Date('2026-10-26T00:00:00Z'))).toBe(0);
    expect(await countActionsInRun(db.db, tenantId(), 'run_test_1')).toBe(0);
    const a = await makeAction({ argumentsRedacted: { amount_minor: 150000, currency: 'USD' } });
    expect(await countActionsInRun(db.db, tenantId(), 'run_test_1')).toBe(1);
    expect(await sumSucceededPaymentsSince(db.db, tenantId(), new Date('2026-10-26T00:00:00Z'))).toBe(0);
    await walkAction(a.actionId, [
      'VALIDATING',
      'EVALUATING',
      'ALLOWED',
      'PERMIT_ISSUED',
      'EXECUTION_PENDING',
      'EXECUTING',
      'SUCCEEDED',
    ]);
    expect(await sumSucceededPaymentsSince(db.db, tenantId(), new Date('2026-10-26T00:00:00Z'))).toBe(150000);
  });

  it('rejects duplicate idempotency keys per agent', async () => {
    await makeAction({ idempotencyKey: 'dup-key' });
    await expect(makeAction({ idempotencyKey: 'dup-key' })).rejects.toSatisfy(isSqlstate('23505'));
  });
});

describe('approval and idempotency repositories', () => {
  it('records approvals once per approver in decision order', async () => {
    const a = await makeAction();
    const first = await createApproval(db.db, {
      approvalId: newId('approval'),
      tenantId: tenantId(),
      actionId: a.actionId,
      actionHash: a.argumentsHash,
      policyRevisionId: seeded.policyRevisionIds[0] ?? '',
      approverUserId: seeded.userIds['approver1'] ?? '',
      decision: 'APPROVE',
      reasonCode: 'MANUAL_REVIEW_PASSED',
    });
    expect(first.decision).toBe('APPROVE');
    await expect(
      createApproval(db.db, {
        approvalId: newId('approval'),
        tenantId: tenantId(),
        actionId: a.actionId,
        actionHash: a.argumentsHash,
        policyRevisionId: seeded.policyRevisionIds[0] ?? '',
        approverUserId: seeded.userIds['approver1'] ?? '',
        decision: 'APPROVE',
        reasonCode: 'MANUAL_REVIEW_PASSED',
      }),
    ).rejects.toSatisfy(isSqlstate('23505'));
    expect(await listApprovalsByAction(db.db, tenantId(), a.actionId)).toHaveLength(1);
  });

  it('tracks idempotency records through their lifecycle', async () => {
    const agent = agentId();
    expect(await findIdempotencyRecord(db.db, tenantId(), agent, 'idem-1')).toBeNull();
    const record = await createIdempotencyRecord(db.db, {
      id: newId('idempotency'),
      tenantId: tenantId(),
      principalId: agent,
      idempotencyKey: 'idem-1',
      requestHash: `sha256:${'dd'.repeat(32)}`,
    });
    expect(record.status).toBe('IN_PROGRESS');
    await completeIdempotencyRecord(db.db, {
      id: record.idempotencyId,
      tenantId: tenantId(),
      responseSnapshot: { ok: true },
      httpStatus: 201,
      resourceId: 'act_1',
    });
    expect((await findIdempotencyRecord(db.db, tenantId(), agent, 'idem-1'))?.status).toBe('COMPLETED');
    const failed = await createIdempotencyRecord(db.db, {
      id: newId('idempotency'),
      tenantId: tenantId(),
      principalId: agent,
      idempotencyKey: 'idem-2',
      requestHash: `sha256:${'dd'.repeat(32)}`,
    });
    await failIdempotencyRecord(db.db, failed.idempotencyId, tenantId());
    expect((await findIdempotencyRecord(db.db, tenantId(), agent, 'idem-2'))?.status).toBe('FAILED');
  });

  it('starts with an empty outbox', async () => {
    expect(await countOutboxByStatus(db.db)).toEqual({});
  });
});
