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
  /**
   * The tenant a write is scoped to.
   *
   * The durable side refuses a write without one — the outbox row's tenant is
   * part of its identity, and a write that cannot name its tenant is a write
   * that could land on another tenant's row. Failing loudly here is the
   * point: a silent no-op would look like a successful publish.
   */
  const tenant = (tenantId: string | undefined): string => {
    if (!tenantId) {
      throw new Error(
        'outbox store: a tenant-scoped write was called without a tenant id, so it cannot be scoped to one row.',
      );
    }
    return tenantId;
  };

  return {
    claimPending: (limit, now) => store.claimPending(limit, now),
    markPublished: (id, tenantId) => store.markPublished(id, clock(), tenant(tenantId)),
    markFailed: (id, errorClass, nextAttemptAt, tenantId) =>
      store.markFailed(id, errorClass, nextAttemptAt ?? clock(), tenant(tenantId)),
    markDead: (id, errorClass, tenantId) => store.markDead(id, errorClass, tenant(tenantId)),
    countByStatus: async () => {
      const counts = await store.countByStatus();
      return {
        PENDING: counts['PENDING'] ?? 0,
        PUBLISHED: counts['PUBLISHED'] ?? 0,
        FAILED: counts['FAILED'] ?? 0,
        DEAD: counts['DEAD'] ?? 0,
      };
    },
    redrive: (id, reason, actorId, tenantId) => store.redrive(id, reason, actorId, tenant(tenantId)),
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
