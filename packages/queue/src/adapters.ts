/**
 * Storage adapters for the queue ports. The dispatcher and the dead-letter
 * path speak `OutboxStore`/`AuditSink`; the durable implementations live in
 * @permitzero/db with slightly different shapes (explicit clocks, richer
 * audit events). These functions close the gap so the API and the worker
 * share one adaptation instead of each inventing it.
 */
import type { DbStores } from '@permitzero/db';
import type { AuditSink, OutboxStore } from './names.js';

export function adaptDbOutbox(store: DbStores['outbox'], clock: () => Date = () => new Date()): OutboxStore {
  return {
    claimPending: (limit, now) => store.claimPending(limit, now),
    markPublished: (id) => store.markPublished(id, clock()),
    markFailed: (id, errorClass, nextAttemptAt) => store.markFailed(id, errorClass, nextAttemptAt ?? clock()),
    markDead: (id, errorClass) => store.markDead(id, errorClass),
    countByStatus: async () => {
      const counts = await store.countByStatus();
      return {
        PENDING: counts['PENDING'] ?? 0,
        PUBLISHED: counts['PUBLISHED'] ?? 0,
        FAILED: counts['FAILED'] ?? 0,
        DEAD: counts['DEAD'] ?? 0,
      };
    },
    redrive: (id, reason, actorId) => store.redrive(id, reason, actorId),
    insert: (draft) => store.insert(draft),
  };
}

export function adaptDbAudit(store: DbStores['audit'], clock: () => Date = () => new Date()): AuditSink {
  return {
    append: async (event) => {
      await store.append({
        tenantId: event.tenantId,
        actionId: null,
        runId: null,
        actorType: 'SYSTEM',
        actorId: event.actorId ?? 'system:worker',
        eventType: event.eventType,
        eventTime: clock(),
        traceId: event.traceId,
        policyRevisionId: null,
        payloadRedacted: { ...event.payload },
      });
    },
  };
}
