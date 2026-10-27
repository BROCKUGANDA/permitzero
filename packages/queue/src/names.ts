import { OutboxStatus } from '@permitzero/domain';

export const QUEUE_NAMES = {
  outbox: 'pz.outbox',
  modelAnalysis: 'pz.model-analysis',
  reconciliation: 'pz.reconciliation',
  replay: 'pz.replay',
  deadLetter: 'pz.dlq',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * BullMQ priorities are lower-is-more-urgent. Reconciliation outranks repeat
 * attempts for unknown financial outcomes (Master Prompt §12.4) because an
 * unreconciled UNKNOWN_OUTCOME is the only state that can hide a double payment.
 */
export const QUEUE_PRIORITY = {
  reconciliation: 1,
  outbox: 5,
  modelAnalysis: 10,
  replay: 20,
  deadLetter: 30,
} as const;

const PRIORITY_BY_QUEUE_NAME: Record<QueueName, number> = {
  [QUEUE_NAMES.reconciliation]: QUEUE_PRIORITY.reconciliation,
  [QUEUE_NAMES.outbox]: QUEUE_PRIORITY.outbox,
  [QUEUE_NAMES.modelAnalysis]: QUEUE_PRIORITY.modelAnalysis,
  [QUEUE_NAMES.replay]: QUEUE_PRIORITY.replay,
  [QUEUE_NAMES.deadLetter]: QUEUE_PRIORITY.deadLetter,
};

/** BullMQ priority for a queue name (lower is more urgent). */
export function queuePriority(name: QueueName): number {
  return PRIORITY_BY_QUEUE_NAME[name];
}

export interface OutboxRow {
  id: string;
  tenantId: string;
  eventType: string;
  queueName: QueueName;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  lastErrorClass: string | null;
  createdAt: Date;
  traceId: string | null;
}

export type OutboxDraft = Pick<OutboxRow, 'tenantId' | 'eventType' | 'queueName' | 'payload'> & {
  maxAttempts?: number;
  nextAttemptAt?: Date | null;
  traceId?: string | null;
};

/**
 * Narrow structural port over the outbox table. `@permitzero/db` satisfies this
 * with its repo module; declaring it here keeps the dependency direction honest
 * and lets the dispatcher be tested without PostgreSQL.
 */
export interface OutboxStore {
  /** Claim a batch for publishing. Must be concurrency-safe: two dispatchers
   * claiming the same batch would publish duplicates. */
  claimPending(limit: number, now: Date): Promise<OutboxRow[]>;
  markPublished(id: string): Promise<boolean>;
  markFailed(id: string, errorClass: string, nextAttemptAt: Date | null): Promise<boolean>;
  markDead(id: string, errorClass: string): Promise<boolean>;
  countByStatus(): Promise<Record<OutboxStatus, number>>;
  /** Audited manual redrive: reset a DEAD row to PENDING. */
  redrive(id: string, reason: string, actorId: string): Promise<OutboxRow | null>;
  insert(draft: OutboxDraft): Promise<OutboxRow>;
}

export interface AuditSink {
  append(event: {
    tenantId: string;
    eventType: string;
    actorId: string | null;
    traceId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
