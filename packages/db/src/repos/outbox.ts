/**
 * Outbox repository: the transactional side of at-least-once delivery.
 *
 * Writers insert a row in the SAME transaction as the domain change. The
 * dispatcher claims rows with a lease (`SELECT … FOR UPDATE SKIP LOCKED` plus
 * a `next_attempt_at` bump in one statement), so two dispatchers never
 * publish the same row twice; a crashed publisher's lease expires and the row
 * becomes claimable again. Structurally satisfies the queue `OutboxStore`
 * port (assigned, never imported, to avoid a package cycle).
 *
 * The payload is stored ENCRYPTED and read back in the clear. The outbox
 * carries the decision an action produced — the action id, the amounts, the
 * reason codes — so it is exactly the kind of content that should not sit in a
 * backup in the clear. The reader decrypts; every consumer inside and outside
 * this package therefore sees the same payload it always did.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { newId } from '@permitzero/domain';
import type { DbExecutor } from '../client.js';
import { currentKey, deriveKey, encryptColumn, readColumn, verificationKeys } from '../crypto.js';
import { outboxEvents } from '../schema.js';
import type { OutboxEventRow } from '../schema.js';

/** The domain-separation label for the outbox payload's encryption key. */
const OUTBOX_PAYLOAD_PURPOSE = 'outbox-payload';

/**
 * The keys that may decrypt an outbox payload: the one the caller supplied,
 * then the environment keyring in order.
 */
function payloadKeys(explicit?: string | null): Buffer[] {
  const masters: string[] = [];
  for (const master of [explicit, ...verificationKeys()]) {
    if (typeof master === 'string' && master.length > 0 && !masters.includes(master)) masters.push(master);
  }
  return masters.map((master) => deriveKey(master, OUTBOX_PAYLOAD_PURPOSE));
}

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

/**
 * How long a claim reserves a row before it becomes claimable again. Exported so
 * the dispatcher's backoff maths and the tests read the same number instead of
 * restating it — a lease that is 60s in the code and 120s in a test is a test
 * that asserts a contract the implementation never made.
 */
export const CLAIM_LEASE_SECONDS = 60;

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

export async function insertOutboxEvent(
  ex: DbExecutor,
  input: InsertOutboxInput,
  opts?: { hmacKey?: string | null },
): Promise<OutboxEventRow> {
  const traceId = input.traceId ?? newId('trace');
  const master = opts?.hmacKey ?? currentKey();
  const payload = { ...input.payload, trace_id: traceId } as Record<string, unknown>;
  const [row] = await ex
    .insert(outboxEvents)
    .values({
      outboxEventId: newId('outboxEvent'),
      tenantId: input.tenantId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      queueName: input.queueName,
      payloadJson: master ? encryptColumn(payload, deriveKey(master, OUTBOX_PAYLOAD_PURPOSE)) : payload,
      maxAttempts: input.maxAttempts ?? 10,
      nextAttemptAt: input.nextAttemptAt ?? null,
    })
    .returning();
  if (!row) throw new Error('outbox insert returned no row');
  return withDecryptedPayload(row, payloadKeys(master));
}

/**
 * The row as the application sees it: the payload in the clear.
 *
 * A payload written before encryption was enabled holds plaintext and is read
 * as it is, so a deployment can turn encryption on without a migration that
 * rewrites the delivery backlog.
 */
function withDecryptedPayload(row: OutboxEventRow, keys: readonly Buffer[]): OutboxEventRow {
  return { ...row, payloadJson: readColumn<Record<string, unknown>>(row.payloadJson, keys) };
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

/**
 * The tenant predicate for a write that knows whose row it is touching.
 *
 * An outbox event id is unique per tenant, not globally, so a write that
 * carries only an id can be pointed at another tenant's row. The tenant
 * parameter is optional here because this repository is also called from
 * places that predate the parameter — but the durable store always supplies
 * it, and a store that cannot name the tenant must not write at all.
 */
function tenantScope(tenantId?: string | null): SQL | undefined {
  return tenantId ? eq(outboxEvents.tenantId, tenantId) : undefined;
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
  // The lease statement returns the raw row, so the payload is still the
  // ciphertext; it is opened here, once, for every consumer of the claim.
  const keys = payloadKeys();
  return rows.map((row) =>
    toClaimed({ ...row, payload_json: readColumn<Record<string, unknown>>(row['payload_json'], keys) }),
  );
}

export async function markOutboxPublished(
  ex: DbExecutor,
  id: string,
  now: Date,
  tenantId?: string | null,
): Promise<boolean> {
  const updated = await ex
    .update(outboxEvents)
    .set({ status: 'PUBLISHED', publishedAt: now })
    .where(and(eq(outboxEvents.outboxEventId, id), sql`${outboxEvents.status} <> 'PUBLISHED'`, tenantScope(tenantId)))
    .returning({ id: outboxEvents.outboxEventId });
  return updated.length > 0;
}

/**
 * Park a row as FAILED.
 *
 * The `status <> 'PUBLISHED'` guard is the same one `markOutboxPublished`
 * carries, and it exists because of a race rather than a rule. A dispatcher
 * whose claim lease expired can still be holding the row when a peer publishes
 * it; the freeze trigger from 0005 then refuses the UPDATE, and that refusal
 * used to abort the whole batch — leaving the remaining claimed rows leased
 * for a minute and swallowing the error entirely.
 *
 * Not touching a published row is the correct outcome in any case: the event
 * is already delivered, and moving it back to FAILED would publish it twice.
 */
export async function markOutboxFailed(
  ex: DbExecutor,
  id: string,
  errorClass: string,
  nextAttemptAt: Date,
  tenantId?: string | null,
): Promise<boolean> {
  const updated = await ex
    .update(outboxEvents)
    .set({ status: 'FAILED', lastErrorClass: errorClass, nextAttemptAt, updatedAt: new Date() })
    .where(and(eq(outboxEvents.outboxEventId, id), sql`${outboxEvents.status} <> 'PUBLISHED'`, tenantScope(tenantId)))
    .returning({ id: outboxEvents.outboxEventId });
  return updated.length > 0;
}

/** Park a row as DEAD. Guarded exactly like `markOutboxFailed`. */
export async function markOutboxDead(
  ex: DbExecutor,
  id: string,
  errorClass: string,
  tenantId?: string | null,
): Promise<boolean> {
  const updated = await ex
    .update(outboxEvents)
    .set({ status: 'DEAD', lastErrorClass: errorClass, updatedAt: new Date() })
    .where(and(eq(outboxEvents.outboxEventId, id), sql`${outboxEvents.status} <> 'PUBLISHED'`, tenantScope(tenantId)))
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

export async function getOutboxEvent(
  ex: DbExecutor,
  id: string,
  tenantId?: string | null,
): Promise<OutboxEventRow | null> {
  const [row] = await ex
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.outboxEventId, id), tenantScope(tenantId)))
    .limit(1);
  return row ? withDecryptedPayload(row, payloadKeys()) : null;
}

export async function redriveOutboxEvent(
  ex: DbExecutor,
  id: string,
  tenantId?: string | null,
): Promise<OutboxEventRow | null> {
  const updated = await ex
    .update(outboxEvents)
    .set({ status: 'PENDING', attemptCount: 0, nextAttemptAt: null, lastErrorClass: null, updatedAt: new Date() })
    .where(and(eq(outboxEvents.outboxEventId, id), eq(outboxEvents.status, 'DEAD'), tenantScope(tenantId)))
    .returning();
  return updated[0] ? withDecryptedPayload(updated[0], payloadKeys()) : null;
}
