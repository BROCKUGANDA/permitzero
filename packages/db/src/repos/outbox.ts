/**
 * Outbox repository: the transactional side of at-least-once delivery.
 *
 * Writers insert a row in the SAME transaction as the domain change. The
 * dispatcher claims rows with a lease (`SELECT … FOR UPDATE SKIP LOCKED` plus
 * a `next_attempt_at` bump in one statement), so two dispatchers never
 * publish the same row twice; a crashed publisher's lease expires and the row
 * becomes claimable again. Structurally satisfies the queue `OutboxStore`
 * port (assigned, never imported, to avoid a package cycle).
 */
import { and, eq, sql } from 'drizzle-orm';
import { newId } from '@permitzero/domain';
import type { DbExecutor } from '../client.js';
import { outboxEvents } from '../schema.js';
import type { OutboxEventRow } from '../schema.js';

/** Mirrors the queue `OutboxRow`/`OutboxStatus`/`QueueName` shapes (see stores.ts). */
export type OutboxStatusName = 'PENDING' | 'PUBLISHED' | 'FAILED' | 'DEAD';
export type QueueName = 'pz.outbox' | 'pz.model-analysis' | 'pz.reconciliation' | 'pz.replay' | 'pz.dlq';

export interface ClaimedOutboxRow {
  id: string;
  tenantId: string;
  eventType: string;
  queueName: QueueName;
  payload: Record<string, unknown>;
  status: OutboxStatusName;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  lastErrorClass: string | null;
  createdAt: Date;
  traceId: string | null;
}

const CLAIM_LEASE_SECONDS = 60;

export interface InsertOutboxInput {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  queueName: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  nextAttemptAt?: Date | null;
  traceId?: string | null;
}

export async function insertOutboxEvent(ex: DbExecutor, input: InsertOutboxInput): Promise<OutboxEventRow> {
  const traceId = input.traceId ?? newId('trace');
  const [row] = await ex
    .insert(outboxEvents)
    .values({
      outboxEventId: newId('outboxEvent'),
      tenantId: input.tenantId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      queueName: input.queueName,
      payloadJson: { ...input.payload, trace_id: traceId } as Record<string, unknown>,
      maxAttempts: input.maxAttempts ?? 10,
      nextAttemptAt: input.nextAttemptAt ?? null,
    })
    .returning();
  if (!row) throw new Error('outbox insert returned no row');
  return row;
}

function toClaimed(row: Record<string, unknown>): ClaimedOutboxRow {
  const payload =
    typeof row['payload_json'] === 'object' && row['payload_json'] !== null
      ? (row['payload_json'] as Record<string, unknown>)
      : {};
  const trace = payload['trace_id'];
  return {
    id: row['outbox_event_id'] as string,
    tenantId: row['tenant_id'] as string,
    eventType: row['event_type'] as string,
    queueName: row['queue_name'] as QueueName,
    payload,
    status: row['status'] as OutboxStatusName,
    attemptCount: Number(row['attempt_count'] ?? 0),
    maxAttempts: Number(row['max_attempts'] ?? 0),
    nextAttemptAt: (row['next_attempt_at'] as Date | null) ?? null,
    lastErrorClass: (row['last_error_class'] as string | null) ?? null,
    createdAt: row['created_at'] as Date,
    traceId: typeof trace === 'string' ? trace : null,
  };
}

export async function claimOutboxEvents(ex: DbExecutor, limit: number, now: Date): Promise<ClaimedOutboxRow[]> {
  const rows = (await ex.execute(sql`
    WITH c AS (
      SELECT outbox_event_id, tenant_id FROM outbox_events
      WHERE status IN ('PENDING', 'FAILED')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now.toISOString()})
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox_events o
    SET attempt_count = o.attempt_count + 1,
        next_attempt_at = ${now.toISOString()}::timestamptz + make_interval(secs => ${CLAIM_LEASE_SECONDS}),
        updated_at = now()
    FROM c
    WHERE o.outbox_event_id = c.outbox_event_id AND o.tenant_id = c.tenant_id
    RETURNING o.*`)) as unknown as Array<Record<string, unknown>>;
  return rows.map(toClaimed);
}

export async function markOutboxPublished(ex: DbExecutor, id: string, now: Date): Promise<boolean> {
  const updated = await ex
    .update(outboxEvents)
    .set({ status: 'PUBLISHED', publishedAt: now })
    .where(and(eq(outboxEvents.outboxEventId, id), sql`${outboxEvents.status} <> 'PUBLISHED'`))
    .returning({ id: outboxEvents.outboxEventId });
  return updated.length > 0;
}

export async function markOutboxFailed(
  ex: DbExecutor,
  id: string,
  errorClass: string,
  nextAttemptAt: Date,
): Promise<boolean> {
  const updated = await ex
    .update(outboxEvents)
    .set({ status: 'FAILED', lastErrorClass: errorClass, nextAttemptAt, updatedAt: new Date() })
    .where(eq(outboxEvents.outboxEventId, id))
    .returning({ id: outboxEvents.outboxEventId });
  return updated.length > 0;
}

export async function markOutboxDead(ex: DbExecutor, id: string, errorClass: string): Promise<boolean> {
  const updated = await ex
    .update(outboxEvents)
    .set({ status: 'DEAD', lastErrorClass: errorClass, updatedAt: new Date() })
    .where(eq(outboxEvents.outboxEventId, id))
    .returning({ id: outboxEvents.outboxEventId });
  return updated.length > 0;
}

export async function countOutboxByStatus(ex: DbExecutor): Promise<Record<string, number>> {
  const rows = await ex
    .select({ status: outboxEvents.status, n: sql<number>`count(*)` })
    .from(outboxEvents)
    .groupBy(outboxEvents.status);
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = Number(row.n);
  return out;
}

export async function getOutboxEvent(ex: DbExecutor, id: string): Promise<OutboxEventRow | null> {
  const [row] = await ex.select().from(outboxEvents).where(eq(outboxEvents.outboxEventId, id)).limit(1);
  return row ?? null;
}

export async function redriveOutboxEvent(ex: DbExecutor, id: string): Promise<OutboxEventRow | null> {
  const updated = await ex
    .update(outboxEvents)
    .set({ status: 'PENDING', attemptCount: 0, nextAttemptAt: null, lastErrorClass: null, updatedAt: new Date() })
    .where(and(eq(outboxEvents.outboxEventId, id), eq(outboxEvents.status, 'DEAD')))
    .returning();
  return updated[0] ?? null;
}
