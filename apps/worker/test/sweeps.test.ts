/**
 * Sweeps: lapsed approval windows expire with their audit trail, and unknown
 * executions past their grace period settle — while in-flight work is left
 * alone.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getAction, transitionAction } from '@permitzero/db';
import {
  closeTestDb,
  connectorIdForTool,
  executionRecord,
  freshWorker,
  makeAction,
  walkTo,
  type WorkerFixture,
} from './helpers.js';
import { sweepExpiredApprovals, sweepUnknownOutcomes } from '../src/sweeps.js';

let t: WorkerFixture;

beforeEach(async () => {
  t = await freshWorker();
});

afterAll(async () => {
  await closeTestDb();
});

async function approvalAction(key: string, expiresAt: Date): Promise<string> {
  const actionId = await makeAction(t, key);
  await walkTo(t, actionId, ['VALIDATING', 'EVALUATING']);
  const current = await getAction(t.db.db, t.tenantId, actionId);
  const moved = await transitionAction(t.db.db, {
    tenantId: t.tenantId,
    actionId,
    to: 'APPROVAL_REQUIRED',
    expectedVersion: current?.version ?? 0,
    now: new Date(),
    patch: { decision: 'REQUIRE_APPROVAL', decisionReasonCodes: ['AMOUNT_OVER_APPROVAL_THRESHOLD'], expiresAt },
  });
  if (!moved.ok) throw new Error('setup transition failed');
  return actionId;
}

describe('sweeps', () => {
  it('expires lapsed approval windows with audit and outbox evidence', async () => {
    const now = new Date();
    const staleId = await approvalAction('sweep-stale', new Date(now.getTime() - 1000));
    const freshId = await approvalAction('sweep-fresh', new Date(now.getTime() + 3_600_000));

    const result = await sweepExpiredApprovals({ db: t.db, stores: t.stores, broker: t.broker }, { now });
    expect(result).toMatchObject({ checked: 1, expired: 1, errors: 0 });
    expect((await getAction(t.db.db, t.tenantId, staleId))?.state).toBe('EXPIRED');
    expect((await getAction(t.db.db, t.tenantId, freshId))?.state).toBe('APPROVAL_REQUIRED');

    const audits = await t.db.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_events WHERE tenant_id = ${t.tenantId} AND event_type = 'action.expired'
    `;
    expect(Number(audits[0]?.n ?? '0')).toBe(1);
    const outbox = await t.db.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM outbox_events WHERE tenant_id = ${t.tenantId} AND event_type = 'action.expired'
    `;
    expect(Number(outbox[0]?.n ?? '0')).toBe(1);
  });

  it('reconciles unknown executions past their grace period', async () => {
    const actionId = await makeAction(t, 'sweep-unknown');
    await walkTo(t, actionId, [
      'VALIDATING',
      'EVALUATING',
      'ALLOWED',
      'PERMIT_ISSUED',
      'EXECUTION_PENDING',
      'EXECUTING',
      'UNKNOWN_OUTCOME',
    ]);
    const connectorId = await connectorIdForTool(t);
    await t.stores.executions.recordIntent(executionRecord(t, actionId, connectorId));
    await t.stores.data.recordDispatch({
      tenantId: t.tenantId,
      connectorIdempotencyKey: `pay:${actionId}:1`,
      operation: 'payment.execute',
      startedAt: new Date(),
      completedAt: null,
      outcome: null,
    });

    // Fresh unknown work is in flight: hands off.
    const skipped = await sweepUnknownOutcomes(
      { db: t.db, stores: t.stores, broker: t.broker },
      { graceMs: 3_600_000 },
    );
    expect(skipped).toMatchObject({ checked: 1, skipped: 1, manual: 0 });
    expect((await getAction(t.db.db, t.tenantId, actionId))?.state).toBe('UNKNOWN_OUTCOME');

    // An hour later the same row settles to a human (open dispatch, no receipt).
    const settled = await sweepUnknownOutcomes(
      { db: t.db, stores: t.stores, broker: t.broker },
      { now: new Date(Date.now() + 3_600_000), graceMs: 60_000 },
    );
    expect(settled).toMatchObject({ checked: 1, manual: 1, errors: 0 });
    expect((await getAction(t.db.db, t.tenantId, actionId))?.state).toBe('MANUAL_REVIEW');
  });
});
