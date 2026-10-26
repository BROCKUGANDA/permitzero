/**
 * Reconciliation handler: unknown executions settle from connector evidence —
 * a receipt means the money moved, an open dispatch with no receipt means a
 * human must look, and nothing dispatching means it never happened. Already
 * settled work skips instead of re-driving.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearConnectorFaultProfile, setConnectorFaultProfile } from '@permitzero/broker';
import { getAction, insertOutboxEvent } from '@permitzero/db';
import { newId } from '@permitzero/domain';
import type { QueueJob } from '@permitzero/queue';
import { createReconciliationHandler } from '../src/handlers/reconcile.js';
import {
  closeTestDb,
  connectorIdForTool,
  executionRecord,
  freshWorker,
  makeAction,
  permitIssuedAction,
  walkTo,
  type WorkerFixture,
} from './helpers.js';

let t: WorkerFixture;

beforeEach(async () => {
  t = await freshWorker();
});

afterAll(async () => {
  await closeTestDb();
});

async function unknownJob(actionId: string, tenantId: string): Promise<QueueJob> {
  const row = await insertOutboxEvent(t.db.db, {
    tenantId,
    aggregateType: 'execution',
    aggregateId: `exe_${actionId}`,
    eventType: 'execution.unknown_outcome',
    queueName: 'pz.reconciliation',
    payload: { action_id: actionId },
    traceId: null,
  });
  return {
    id: 'job_1',
    name: 'execution.unknown_outcome',
    queue: 'pz.reconciliation',
    data: { outboxId: row.outboxEventId, tenantId, eventType: 'execution.unknown_outcome' },
    attempt: 1,
    tenantId,
    traceId: null,
  };
}

describe('reconciliation handler', () => {
  it('resolves a timed-out dispatch from its receipt', async () => {
    const { actionId, token } = await permitIssuedAction(t, 'rec-receipt');
    setConnectorFaultProfile({ timeoutAfterDispatch: true });
    try {
      const outcome = await t.broker.execute({
        tenantId: t.tenantId,
        actionId,
        permitToken: token,
        actorId: t.agentId,
        traceId: newId('trace'),
      });
      expect(outcome.outcome).toBe('UNKNOWN_OUTCOME');
    } finally {
      clearConnectorFaultProfile();
    }

    const result = await createReconciliationHandler({ db: t.db, broker: t.broker })(
      await unknownJob(actionId, t.tenantId),
    );
    expect(result).toEqual({ outcome: 'DONE' });
    expect((await getAction(t.db.db, t.tenantId, actionId))?.state).toBe('SUCCEEDED');
  });

  it('sends open dispatches without a receipt to a human', async () => {
    const actionId = await makeAction(t, 'rec-manual');
    await walkTo(t, actionId, ['VALIDATING', 'EVALUATING', 'ALLOWED', 'PERMIT_ISSUED', 'EXECUTION_PENDING', 'EXECUTING', 'UNKNOWN_OUTCOME']);
    const connectorId = await connectorIdForTool(t);
    const execution = executionRecord(t, actionId, connectorId);
    await t.stores.executions.recordIntent(execution);
    await t.stores.data.recordDispatch({
      tenantId: t.tenantId,
      connectorIdempotencyKey: execution.connectorIdempotencyKey,
      operation: 'payment.execute',
      startedAt: new Date(),
      completedAt: null,
      outcome: null,
    });

    const result = await createReconciliationHandler({ db: t.db, broker: t.broker })(
      await unknownJob(actionId, t.tenantId),
    );
    expect(result).toEqual({ outcome: 'DONE' });
    expect((await getAction(t.db.db, t.tenantId, actionId))?.state).toBe('MANUAL_REVIEW');
  });

  it('fails executions that never dispatched', async () => {
    const actionId = await makeAction(t, 'rec-never');
    await walkTo(t, actionId, ['VALIDATING', 'EVALUATING', 'ALLOWED', 'PERMIT_ISSUED', 'EXECUTION_PENDING', 'EXECUTING', 'UNKNOWN_OUTCOME']);
    const connectorId = await connectorIdForTool(t);
    await t.stores.executions.recordIntent(executionRecord(t, actionId, connectorId));

    const result = await createReconciliationHandler({ db: t.db, broker: t.broker })(
      await unknownJob(actionId, t.tenantId),
    );
    expect(result).toEqual({ outcome: 'DONE' });
    expect((await getAction(t.db.db, t.tenantId, actionId))?.state).toBe('FAILED_TERMINAL');
  });

  it('skips work that already settled', async () => {
    const { actionId, token } = await permitIssuedAction(t, 'rec-settled');
    const outcome = await t.broker.execute({
      tenantId: t.tenantId,
      actionId,
      permitToken: token,
      actorId: t.agentId,
      traceId: newId('trace'),
    });
    expect(outcome.outcome).toBe('SUCCEEDED');

    const result = await createReconciliationHandler({ db: t.db, broker: t.broker })(
      await unknownJob(actionId, t.tenantId),
    );
    expect(result).toEqual({ outcome: 'SKIPPED_STALE', reason: 'action already SUCCEEDED' });
  });

  it('skips vanished rows and actions instead of failing', async () => {
    const handler = createReconciliationHandler({ db: t.db, broker: t.broker });
    const ghostRow: QueueJob = {
      id: 'job_1',
      name: 'execution.unknown_outcome',
      queue: 'pz.reconciliation',
      data: { outboxId: 'obx_nope', tenantId: t.tenantId },
      attempt: 1,
      tenantId: t.tenantId,
      traceId: null,
    };
    expect(await handler(ghostRow)).toEqual({ outcome: 'SKIPPED_STALE', reason: 'outbox row is gone' });

    const ghostAction = await unknownJob(newId('action'), t.tenantId);
    expect(await handler(ghostAction)).toEqual({ outcome: 'SKIPPED_STALE', reason: 'action is gone' });
  });

  it('dead-letters unknown events and malformed payloads', async () => {
    const handler = createReconciliationHandler({ db: t.db, broker: t.broker });
    const wrong: QueueJob = {
      id: 'job_1',
      name: 'action.decided',
      queue: 'pz.reconciliation',
      data: { outboxId: 'obx_1', tenantId: t.tenantId },
      attempt: 1,
      tenantId: t.tenantId,
      traceId: null,
    };
    expect(await handler(wrong)).toEqual({ outcome: 'FAILED', errorClass: 'UNKNOWN_EVENT_TYPE' });
    const malformed: QueueJob = {
      id: 'job_1',
      name: 'execution.unknown_outcome',
      queue: 'pz.reconciliation',
      data: { outboxId: 'obx_1' },
      attempt: 1,
      tenantId: null,
      traceId: null,
    };
    expect(await handler(malformed)).toEqual({ outcome: 'FAILED', errorClass: 'INVALID_JOB_PAYLOAD' });
  });
});
