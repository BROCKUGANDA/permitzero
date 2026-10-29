/**
 * Audit repository: hash-chained, append-only event log.
 *
 * The application takes the chain advisory lock for the tenant, reads the chain
 * head, computes the new event hash over the canonical event plus the previous
 * hash, and inserts with `sequence` omitted. The BEFORE trigger assigns the
 * sequence under the same lock (transaction-scoped, so re-acquiring it is a
 * no-op) and verifies the previous hash still matches head. The lock is taken
 * before the read rather than only at insert because a collision cannot be
 * retried inside a transaction: the failed insert aborts it, and the retry's next
 * statement fails with 25P02 instead of colliding again. Event times are
 * truncated to milliseconds (JavaScript Date precision) so a PostgreSQL
 * round-trip never changes the hashed bytes.
 *
 * The payload is stored ENCRYPTED and hashed in the clear. The order matters:
 * the hash is computed over the canonical PLAINTEXT, so the chain still proves
 * what the decision was, and the bytes on disk are ciphertext. Hashing the
 * ciphertext instead would have been simpler and would have proved only that
 * a ciphertext was not altered — not what was decided.
 */
import { createHash, createHmac } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { canonicalize, newId } from '@permitzero/domain';
import type { ActorType, AuditEventRecord } from '@permitzero/domain';
import { isDbError, type DbExecutor } from '../client.js';
import { currentKey, DecryptionError, deriveKey, encryptColumn, readColumn, verificationKeys } from '../crypto.js';
import { toAuditEventRecord } from '../mappers.js';
import { auditEvents } from '../schema.js';

export const AUDIT_HASH_VERSION_PLAIN = 'pz-audit-v1';
export const AUDIT_HASH_VERSION_HMAC = 'pz-audit-hmac-v1';

/** The domain-separation label for the audit payload's encryption key. */
const AUDIT_PAYLOAD_PURPOSE = 'audit-payload';

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

export function computeAuditHash(input: AuditHashInput, hmacKey?: string | null): { hash: string; version: string } {
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

/**
 * The master keys that may verify or decrypt this tenant's audit rows.
 *
 * The explicitly supplied key comes first, then the environment keyring in
 * order — current first, then the keys that were current before it. A row
 * written under an older key therefore stays verifiable for as long as that
 * key is in the ring, which is what makes a rotation survivable: the new key
 * is added to the ring BEFORE it becomes current, so no row is ever written
 * with a key the verifier cannot reach.
 */
function candidateMasters(explicit?: string | null): string[] {
  const out: string[] = [];
  for (const master of [explicit, ...verificationKeys()]) {
    if (typeof master === 'string' && master.length > 0 && !out.includes(master)) out.push(master);
  }
  return out;
}

/** The derived keys that may decrypt an audit payload. */
function payloadKeys(masters: readonly string[]): Buffer[] {
  return masters.map((master) => deriveKey(master, AUDIT_PAYLOAD_PURPOSE));
}

/**
 * The payload as it was written, whether it is stored in the clear or as an
 * envelope.
 *
 * THE LEGACY RULE: a row written before encryption was enabled holds a
 * plaintext payload, and it is used as it is. `audit_events` is append-only,
 * so such a row can never be rewritten in place; refusing to read it would
 * turn a migration into an outage, and silently rewriting it would rewrite
 * evidence.
 */
function readAuditPayload(stored: unknown, keys: readonly Buffer[]): Record<string, unknown> {
  const value = readColumn<Record<string, unknown>>(stored, keys);
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/** The row as the application sees it: the payload in the clear. */
function decryptedAuditRow<T extends { payloadRedactedJson: unknown }>(row: T, keys: readonly Buffer[]): T {
  return { ...row, payloadRedactedJson: readAuditPayload(row.payloadRedactedJson, keys) };
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

/**
 * The three messages `trg_audit_events_chain` raises when another writer has moved
 * the head (infra/migrations/0002_triggers.sql). They are matched positively rather
 * than by SQLSTATE because the trigger raises `check_violation` — the same code any
 * real CHECK on the table uses — and postgres.js does not surface a constraint name
 * for a trigger-raised error, so "no constraint named" would also catch a row that
 * simply is not allowed.
 */
const CHAIN_COLLISION_MESSAGES = [
  /audit hash chain broken for tenant/,
  /audit sequence .* is not the next value for tenant/,
  /genesis audit event for tenant .* must have a NULL previous_hash/,
];

/**
 * Is this error contention, or a row that breaks a rule?
 *
 * Treating a rule violation as retryable is actively harmful: the retry dies on
 * 25P02 inside a transaction, so a bad payload surfaces as a 500 that mentions the
 * aborted retry instead of the constraint, and the HTTP boundary never gets the
 * 422 it would have produced from it.
 */
export function isAuditChainCollision(err: unknown): boolean {
  if (isDbError(err, '23505')) return true;
  if (!isDbError(err, '23514')) return false;
  const message = String(
    (err as { cause?: { message?: string }; message?: string }).cause?.message ??
      (err as { message?: string }).message ??
      '',
  );
  return CHAIN_COLLISION_MESSAGES.some((pattern) => pattern.test(message));
}

export async function appendAuditEvent(
  ex: DbExecutor,
  input: AppendAuditInput,
  opts?: { hmacKey?: string | null },
): Promise<AuditEventRecord> {
  const eventId = input.eventId ?? newId('auditEvent');
  const eventTime = truncateToMs(input.eventTime ?? new Date());
  // The key that WRITES is the key that is current: the one the caller
  // supplied, otherwise the head of the environment keyring. The payload is
  // encrypted with a key derived from it, so a deployment without a key stores
  // plaintext — which is the pre-existing unkeyed behaviour, degraded and
  // visible, rather than a silent substitute key.
  const master = opts?.hmacKey ?? currentKey();
  let lastError: unknown = null;
  // Take the chain lock before reading the head, not at insert time.
  //
  // The trigger already holds this same advisory lock, but it only takes it once
  // the head has been read and the hash computed — and inside a transaction a
  // collision at that point is unrecoverable: the failed insert aborts the
  // transaction, so the retry's very next statement dies with 25P02 rather than
  // re-reading the head. Sequential tests cannot see this (one writer never
  // collides); under load it surfaces as a 500. Locking here makes a concurrent
  // writer wait on this statement instead, which is the back-pressure the chain
  // needs anyway. `pg_advisory_xact_lock` is idempotent for a key already held by
  // the transaction, so the trigger's acquisition afterwards is a no-op, and on a
  // non-transactional executor the lock simply releases at statement end and the
  // retry loop below still works, because each statement there is its own
  // transaction.
  await ex.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('pz_audit_chain:' || ${input.tenantId}, 0))`);
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
      // The hash uses the same key the payload is encrypted with, so a row is
      // never "keyed but unencrypted" or "encrypted but unkeyed": the two would
      // disagree about what a reader needs in order to check the row.
      master,
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
          // The hash above was computed over the canonical PLAINTEXT; what
          // lands in the column is the ciphertext. The two are deliberately
          // different things: the hash is the record of the decision, the
          // column is how the decision is stored.
          payloadRedactedJson: master
            ? encryptColumn(input.payload, deriveKey(master, AUDIT_PAYLOAD_PURPOSE))
            : input.payload,
          eventHash: hash,
          previousHash,
          hashVersion: version,
          traceId: input.traceId,
          eventTime,
        })
        .returning();
      if (!row) throw new Error('audit insert returned no row');
      return toAuditEventRecord(decryptedAuditRow(row, payloadKeys(candidateMasters(master))));
    } catch (err) {
      // Contention: another writer moved the head, so re-read it and try again.
      // Anything else — including a plain CHECK violation on the row — is a bug in
      // what we were asked to write, and retrying it only hides it behind a 25P02.
      if (isAuditChainCollision(err)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('audit append collided repeatedly');
}

export async function getAuditHead(
  ex: DbExecutor,
  tenantId: string,
): Promise<{ sequence: number; eventHash: string } | null> {
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
  opts: { limit: number; cursor?: string | null; hmacKey?: string | null },
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
  // The rows on disk are ciphertext; the records the API returns are the
  // payloads as they were written. A row that cannot be decrypted fails the
  // read loudly rather than being returned with an empty payload: an audit
  // page that silently omits what it cannot decrypt is worse than one that
  // says the keyring is wrong.
  const keys = payloadKeys(candidateMasters(opts.hmacKey));
  return {
    rows: page.map((row) => toAuditEventRecord(decryptedAuditRow(row, keys))),
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
 *
 * The payload is decrypted before the hash is recomputed, because the hash
 * covers the canonical PLAINTEXT. Every key in the ring is tried: the current
 * one first, then the ones that were current before it, so a chain written
 * under a retired-but-still-verifying key still verifies.
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
  const masters = candidateMasters(opts?.hmacKey);
  const keys = payloadKeys(masters);
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
    if (keyed && masters.length === 0) {
      breaks.push({ sequence, eventId: row.eventId, reason: 'keyed hash but no key provided for verification' });
    } else {
      let payload: Record<string, unknown>;
      try {
        payload = readAuditPayload(row.payloadRedactedJson, keys);
      } catch (err) {
        // The payload could not be opened. GCM cannot tell "the bytes were
        // altered" from "this key is not the one that wrote the row", and the
        // message says both rather than guessing: an operator reading it has
        // to check the keyring and the row, and both are worth checking.
        breaks.push({
          sequence,
          eventId: row.eventId,
          reason:
            err instanceof DecryptionError && err.reason === 'MALFORMED'
              ? 'payload envelope is malformed'
              : 'payload failed authentication: the ciphertext was altered, or no key provided for verification could open it',
        });
        previous = row.eventHash;
        expectedSequence = sequence + 1;
        continue;
      }
      const hashInput = {
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
      };
      // Any key in the ring may be the one this row was written with, so the
      // row verifies when ANY of them reproduces its hash. Trying them in
      // order costs one HMAC per key and turns "which key wrote this row?"
      // into a question the verifier can answer on its own.
      const matched = keyed
        ? masters.some((master) => computeAuditHash(hashInput, master).hash === row.eventHash)
        : computeAuditHash(hashInput, null).hash === row.eventHash;
      if (!matched) {
        breaks.push({ sequence, eventId: row.eventId, reason: 'event hash mismatch: bytes changed after append' });
      }
    }
    previous = row.eventHash;
    expectedSequence = sequence + 1;
  }
  return { checked: rows.length, chainValid: breaks.length === 0, breaks };
}
