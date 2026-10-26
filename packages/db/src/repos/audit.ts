/**
 * Audit repository: hash-chained, append-only event log.
 *
 * The application reads the chain head, computes the new event hash over the
 * canonical event plus the previous hash, and inserts with `sequence` omitted.
 * A BEFORE trigger assigns the sequence under a transaction-scoped advisory
 * lock and verifies the previous hash still matches head; on a concurrent
 * move the insert fails and the application retries with the new head.
 * Event times are truncated to milliseconds (JavaScript Date precision) so a
 * PostgreSQL round-trip never changes the hashed bytes.
 */
import { createHash, createHmac } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { canonicalize, newId } from '@permitzero/domain';
import type { ActorType, AuditEventRecord } from '@permitzero/domain';
import { isDbError, type DbExecutor } from '../client.js';
import { toAuditEventRecord } from '../mappers.js';
import { auditEvents } from '../schema.js';

export const AUDIT_HASH_VERSION_PLAIN = 'pz-audit-v1';
export const AUDIT_HASH_VERSION_HMAC = 'pz-audit-hmac-v1';

export interface AuditHashInput {
  tenantId: string;
  eventId: string;
  actionId: string | null;
  runId: string | null;
  actorType: string;
  actorId: string;
  eventType: string;
  eventTime: Date;
  traceId: string;
  policyRevisionId: string | null;
  payload: Record<string, unknown>;
  previousHash: string | null;
}

export function computeAuditHash(
  input: AuditHashInput,
  hmacKey?: string | null,
): { hash: string; version: string } {
  const version = hmacKey ? AUDIT_HASH_VERSION_HMAC : AUDIT_HASH_VERSION_PLAIN;
  const canonical = canonicalize({
    v: version,
    tenant: input.tenantId,
    event_id: input.eventId,
    action_id: input.actionId,
    run_id: input.runId,
    actor_type: input.actorType,
    actor_id: input.actorId,
    event_type: input.eventType,
    event_time: input.eventTime,
    trace_id: input.traceId,
    policy_revision: input.policyRevisionId,
    payload: input.payload,
    previous_hash: input.previousHash ?? 'GENESIS',
  });
  const digest = hmacKey
    ? createHmac('sha256', hmacKey).update(canonical, 'utf8').digest('hex')
    : createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { hash: `sha256:${digest}`, version };
}

function truncateToMs(date: Date): Date {
  return new Date(Math.floor(date.getTime()));
}

export interface AppendAuditInput {
  eventId?: string;
  tenantId: string;
  actionId?: string | null;
  runId?: string | null;
  actorType: ActorType;
  actorId: string;
  eventType: string;
  eventTime?: Date;
  traceId: string;
  policyRevisionId?: string | null;
  payload: Record<string, unknown>;
}

const APPEND_ATTEMPTS = 5;

export async function appendAuditEvent(
  ex: DbExecutor,
  input: AppendAuditInput,
  opts?: { hmacKey?: string | null },
): Promise<AuditEventRecord> {
  const eventId = input.eventId ?? newId('auditEvent');
  const eventTime = truncateToMs(input.eventTime ?? new Date());
  let lastError: unknown = null;
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    const head = await ex
      .select({ sequence: auditEvents.sequence, eventHash: auditEvents.eventHash })
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, input.tenantId))
      .orderBy(desc(auditEvents.sequence))
      .limit(1);
    const previousHash = head[0]?.eventHash ?? null;
    const { hash, version } = computeAuditHash(
      {
        tenantId: input.tenantId,
        eventId,
        actionId: input.actionId ?? null,
        runId: input.runId ?? null,
        actorType: input.actorType,
        actorId: input.actorId,
        eventType: input.eventType,
        eventTime,
        traceId: input.traceId,
        policyRevisionId: input.policyRevisionId ?? null,
        payload: input.payload,
        previousHash,
      },
      opts?.hmacKey,
    );
    try {
      const [row] = await ex
        .insert(auditEvents)
        .values({
          // NULL sequence: the trigger assigns it under the chain lock.
          sequence: null as unknown as bigint,
          eventId,
          tenantId: input.tenantId,
          eventType: input.eventType,
          actionId: input.actionId ?? null,
          runId: input.runId ?? null,
          actorType: input.actorType,
          actorId: input.actorId,
          policyRevisionId: input.policyRevisionId ?? null,
          payloadRedactedJson: input.payload,
          eventHash: hash,
          previousHash,
          hashVersion: version,
          traceId: input.traceId,
          eventTime,
        })
        .returning();
      if (!row) throw new Error('audit insert returned no row');
      return toAuditEventRecord(row);
    } catch (err) {
      // Concurrent head move (or sequence race): retry with the new head.
      if (isDbError(err, '23505', '23514')) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('audit append collided repeatedly');
}

export async function getAuditHead(ex: DbExecutor, tenantId: string): Promise<{ sequence: number; eventHash: string } | null> {
  const [row] = await ex
    .select({ sequence: auditEvents.sequence, eventHash: auditEvents.eventHash })
    .from(auditEvents)
    .where(eq(auditEvents.tenantId, tenantId))
    .orderBy(desc(auditEvents.sequence))
    .limit(1);
  return row ? { sequence: Number(row.sequence), eventHash: row.eventHash } : null;
}

export interface ListAuditFilters {
  actionId?: string;
  runId?: string;
  actorId?: string;
  eventType?: string;
  from?: Date;
  to?: Date;
}

function encodeCursor(eventTime: Date, eventId: string): string {
  return Buffer.from(JSON.stringify({ t: eventTime.toISOString(), e: eventId }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { t: string; e: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; e?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.e !== 'string') return null;
    return { t: parsed.t, e: parsed.e };
  } catch {
    return null;
  }
}

export async function listAuditEvents(
  ex: DbExecutor,
  tenantId: string,
  filters: ListAuditFilters,
  opts: { limit: number; cursor?: string | null },
): Promise<{ rows: AuditEventRecord[]; nextCursor: string | null }> {
  const conditions = [eq(auditEvents.tenantId, tenantId)];
  if (filters.actionId) conditions.push(eq(auditEvents.actionId, filters.actionId));
  if (filters.runId) conditions.push(eq(auditEvents.runId, filters.runId));
  if (filters.actorId) conditions.push(eq(auditEvents.actorId, filters.actorId));
  if (filters.eventType) conditions.push(eq(auditEvents.eventType, filters.eventType));
  // ISO text, not bound Dates: see the note in repos/actions.ts listActions.
  if (filters.from) conditions.push(sql`${auditEvents.eventTime} >= ${filters.from.toISOString()}`);
  if (filters.to) conditions.push(sql`${auditEvents.eventTime} <= ${filters.to.toISOString()}`);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cursor) {
    conditions.push(sql`(${auditEvents.eventTime}, ${auditEvents.eventId}) < (${cursor.t}::timestamptz, ${cursor.e})`);
  }
  const rows = await ex
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.eventTime), desc(auditEvents.eventId))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map(toAuditEventRecord),
    nextCursor: rows.length > opts.limit && last ? encodeCursor(last.eventTime, last.eventId) : null,
  };
}

export interface ChainBreak {
  sequence: number;
  eventId: string;
  reason: string;
}

export interface ChainVerification {
  checked: number;
  chainValid: boolean;
  breaks: ChainBreak[];
}

/**
 * Recompute every hash and linkage for a tenant. Keyed rows need the HMAC key;
 * without it they are reported, not guessed.
 */
export async function verifyAuditChain(
  ex: DbExecutor,
  tenantId: string,
  opts?: { hmacKey?: string | null },
): Promise<ChainVerification> {
  const rows = await ex
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.tenantId, tenantId))
    .orderBy(asc(auditEvents.sequence));
  const breaks: ChainBreak[] = [];
  let previous: string | null = null;
  let expectedSequence = 1;
  for (const row of rows) {
    const sequence = Number(row.sequence);
    if (sequence !== expectedSequence) {
      breaks.push({ sequence, eventId: row.eventId, reason: `sequence gap: expected ${expectedSequence}` });
    }
    if (row.previousHash !== previous) {
      breaks.push({ sequence, eventId: row.eventId, reason: 'previous-hash link broken' });
    }
    const keyed = row.hashVersion === AUDIT_HASH_VERSION_HMAC;
    if (keyed && !opts?.hmacKey) {
      breaks.push({ sequence, eventId: row.eventId, reason: 'keyed hash but no key provided for verification' });
    } else {
      const payload =
        typeof row.payloadRedactedJson === 'object' && row.payloadRedactedJson !== null && !Array.isArray(row.payloadRedactedJson)
          ? (row.payloadRedactedJson as Record<string, unknown>)
          : {};
      const { hash } = computeAuditHash(
        {
          tenantId: row.tenantId,
          eventId: row.eventId,
          actionId: row.actionId,
          runId: row.runId,
          actorType: row.actorType,
          actorId: row.actorId,
          eventType: row.eventType,
          eventTime: truncateToMs(row.eventTime),
          traceId: row.traceId,
          policyRevisionId: row.policyRevisionId,
          payload,
          previousHash: row.previousHash,
        },
        keyed ? opts?.hmacKey : null,
      );
      if (hash !== row.eventHash) {
        breaks.push({ sequence, eventId: row.eventId, reason: 'event hash mismatch: bytes changed after append' });
      }
    }
    previous = row.eventHash;
    expectedSequence = sequence + 1;
  }
  return { checked: rows.length, chainValid: breaks.length === 0, breaks };
}
