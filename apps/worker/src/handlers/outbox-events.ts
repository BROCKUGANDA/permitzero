/**
 * Consumer for `pz.outbox`: domain events the API committed alongside its
 * state changes. Today's events are informational — the audit trail was
 * already written at the source — so the router validates the envelope,
 * acknowledges the known ones and dead-letters anything it cannot parse or
 * route. Reactions (notifications, webhooks) attach here without touching
 * the dispatcher.
 */
import type { HandlerResult, JobHandler, QueueJob } from '@permitzero/queue';

const KNOWN_EVENTS = new Set([
  'action.decided',
  'action.approved',
  'action.rejected',
  'action.expired',
]);

export interface JobEnvelope {
  outboxId: string;
  tenantId: string;
  eventType: string;
  traceId: string | null;
}

function parseEnvelope(job: QueueJob): JobEnvelope | null {
  if (typeof job.data !== 'object' || job.data === null) return null;
  const data = job.data as Record<string, unknown>;
  const outboxId = data['outboxId'];
  const tenantId = data['tenantId'] ?? job.tenantId;
  const eventType = typeof data['eventType'] === 'string' ? data['eventType'] : job.name;
  const traceId = data['traceId'] ?? job.traceId ?? null;
  if (typeof outboxId !== 'string' || outboxId.length === 0) return null;
  if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
  if (typeof eventType !== 'string' || eventType.length === 0) return null;
  if (traceId !== null && typeof traceId !== 'string') return null;
  return { outboxId, tenantId, eventType, traceId };
}

export function createOutboxRouter(): JobHandler {
  return async (job: QueueJob): Promise<HandlerResult> => {
    const envelope = parseEnvelope(job);
    if (!envelope) {
      return { outcome: 'FAILED', errorClass: 'INVALID_JOB_PAYLOAD' };
    }
    if (!KNOWN_EVENTS.has(envelope.eventType)) {
      return { outcome: 'FAILED', errorClass: 'UNKNOWN_EVENT_TYPE' };
    }
    return { outcome: 'DONE' };
  };
}
