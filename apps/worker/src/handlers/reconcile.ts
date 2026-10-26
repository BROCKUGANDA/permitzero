/**
 * Consumer for `pz.reconciliation`: settles executions the broker could not
 * call finished. The handler re-checks the action first — at-least-once
 * delivery means the same nudge can arrive twice, and the periodic sweep may
 * have settled it already — and lets `broker.reconcile` do the rest. Anything
 * already decided is SKIPPED_STALE (the idempotency check succeeding), never
 * re-driven.
 */
import { NotFoundError } from '@permitzero/domain';
import type { Broker } from '@permitzero/broker';
import { getAction, getOutboxEvent } from '@permitzero/db';
import type { Db } from '@permitzero/db';
import type { HandlerResult, JobHandler, QueueJob } from '@permitzero/queue';

export interface ReconcileHandlerDeps {
  db: Db;
  broker: Broker;
}

const RECONCILABLE_STATES = new Set(['UNKNOWN_OUTCOME', 'RECONCILING']);

function payloadOf(job: QueueJob): Record<string, unknown> | null {
  return typeof job.data === 'object' && job.data !== null ? (job.data as Record<string, unknown>) : null;
}

export function createReconciliationHandler(deps: ReconcileHandlerDeps): JobHandler {
  return async (job: QueueJob): Promise<HandlerResult> => {
    if (job.name !== 'execution.unknown_outcome') {
      return { outcome: 'FAILED', errorClass: 'UNKNOWN_EVENT_TYPE' };
    }
    const data = payloadOf(job);
    const tenantId = job.tenantId ?? (typeof data?.['tenantId'] === 'string' ? data['tenantId'] : null);
    const outboxId = data?.['outboxId'];
    if (typeof tenantId !== 'string' || typeof outboxId !== 'string') {
      return { outcome: 'FAILED', errorClass: 'INVALID_JOB_PAYLOAD' };
    }

    // The job carries identifiers only; the outbox row holds the reference.
    const row = await getOutboxEvent(deps.db.db, outboxId);
    if (!row) {
      return { outcome: 'SKIPPED_STALE', reason: 'outbox row is gone' };
    }
    const payload = row.payloadJson as Record<string, unknown> | null;
    const actionId = payload?.['action_id'];
    if (typeof actionId !== 'string') {
      return { outcome: 'FAILED', errorClass: 'INVALID_JOB_PAYLOAD' };
    }

    const action = await getAction(deps.db.db, tenantId, actionId);
    if (!action) {
      return { outcome: 'SKIPPED_STALE', reason: 'action is gone' };
    }
    if (!RECONCILABLE_STATES.has(action.state)) {
      return { outcome: 'SKIPPED_STALE', reason: `action already ${action.state}` };
    }

    try {
      await deps.broker.reconcile(actionId, tenantId);
      return { outcome: 'DONE' };
    } catch (err) {
      if (err instanceof NotFoundError) {
        return { outcome: 'SKIPPED_STALE', reason: 'action vanished mid-flight' };
      }
      throw err;
    }
  };
}
