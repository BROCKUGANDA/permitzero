/**
 * Encryption at rest: what the database actually holds, and what the audit
 * chain still proves.
 *
 * The point of these tests is not that a ciphertext round-trips — it is that
 * the CONTROL is not weakened by encrypting. The chain's tamper-evidence used
 * to rest on the hash alone; after encryption it rests on the hash AND on the
 * GCM authentication tag, and a test that only checked the happy path would
 * not know which of the two is doing the work.
 *
 * The key environment is set explicitly rather than inherited. A test that
 * depends on whether the machine happens to have `AUDIT_HMAC_KEY` exported is a
 * test that passes in one place and fails in another.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@permitzero/domain';
import {
  appendAuditEvent,
  AUDIT_HASH_VERSION_HMAC,
  AUDIT_HASH_VERSION_PLAIN,
  computeAuditHash,
  insertOutboxEvent,
  listAuditEvents,
  reanchorAuditHash,
  seed,
  verifyAuditChain,
  type Db,
  type SeedResult,
} from '../src/index.js';
import { DecryptionError, decrypt, deriveKey, encrypt } from '../src/crypto.js';
import { closeTestDb, resetTestDb, testDb } from './db-test.js';

let db: Db;
let seeded: SeedResult;

const TENANT = () => seeded.tenantIds[0] ?? '';
const TEST_KEY = 'test-encryption-master-key-0123456789';
const OTHER_KEY = 'a-different-master-key-0123456789abcd';

/** The payload marker that must never appear in the stored bytes. */
const SECRET = 'beneficiary-ref-SECRET-0042';

const ORIGINAL_KEYRING = process.env['AUDIT_HMAC_KEYS'];
const ORIGINAL_SINGLE_KEY = process.env['AUDIT_HMAC_KEY'];

function useKeyring(keys: string | null): void {
  if (keys === null) {
    delete process.env['AUDIT_HMAC_KEYS'];
  } else {
    process.env['AUDIT_HMAC_KEYS'] = keys;
  }
  delete process.env['AUDIT_HMAC_KEY'];
}

beforeAll(async () => {
  db = await testDb();
});

afterAll(async () => {
  if (ORIGINAL_KEYRING === undefined) delete process.env['AUDIT_HMAC_KEYS'];
  else process.env['AUDIT_HMAC_KEYS'] = ORIGINAL_KEYRING;
  if (ORIGINAL_SINGLE_KEY === undefined) delete process.env['AUDIT_HMAC_KEY'];
  else process.env['AUDIT_HMAC_KEY'] = ORIGINAL_SINGLE_KEY;
  await closeTestDb();
});

beforeEach(async () => {
  useKeyring(TEST_KEY);
  await resetTestDb();
  seeded = await seed(db);
});

function event(n: number) {
  return {
    tenantId: TENANT(),
    actionId: null,
    runId: null,
    actorType: 'SYSTEM' as const,
    actorId: 'system:encryption-test',
    eventType: 'system.config_changed',
    eventTime: new Date(`2026-10-26T12:00:0${n}Z`),
    traceId: newId('trace'),
    policyRevisionId: null,
    payload: { n, note: SECRET },
  };
}

/**
 * Rewrite the stored ciphertext in place, the way an attacker with database
 * access would.
 *
 * The audit table refuses UPDATE and DELETE through a trigger, because a
 * correction is supposed to be a compensating event. The trigger is disabled
 * for the duration of the tamper — as the table owner, in a test database —
 * because the point of the test is to see what verification says about bytes
 * that were changed behind its back.
 */
async function tamperWithStoredPayload(): Promise<void> {
  await db.sql`ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_no_update`;
  try {
    const rows = await db.sql<{ payload: string }[]>`
      SELECT payload_redacted_json::text AS payload FROM audit_events WHERE tenant_id = ${TENANT()}`;
    const stored = JSON.parse(rows[0]?.payload ?? '{}') as { __pz_enc?: string };
    const envelope = stored.__pz_enc ?? '';
    // Alter the FIRST character of the ciphertext segment, not the last.
    //
    // The envelope is unpadded base64url, and in the last character of a
    // four-character group only the top two bits are significant — the other
    // four are padding that the decoder ignores. So 'A' and 'B' decode to
    // the SAME byte, and tampering with the end of the string changes
    // nothing: the ciphertext is identical and the GCM tag still verifies.
    //
    // The test would have passed for the wrong reason, which is worse than
    // failing. The first character of a group carries all six bits, so
    // changing it always changes the decoded byte.
    const parts = envelope.split('.');
    const ciphertext = parts[parts.length - 1] ?? '';
    parts[parts.length - 1] = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;
    const tampered = { __pz_enc: parts.join('.') };
    await db.sql`
      UPDATE audit_events
      SET payload_redacted_json = ${JSON.stringify(tampered)}::jsonb
      WHERE tenant_id = ${TENANT()}`;
  } finally {
    await db.sql`ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_no_update`;
  }
}

describe('re-anchoring a chain row', () => {
  /**
   * A stored row, as the retention sweep reads it.
   *
   * The payload is the STORED value — ciphertext when the deployment has a
   * key — because that is what the sweep has in hand when it re-links a
   * survivor.
   */
  async function storedRow(sequence: number): Promise<{
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
    storedPayload: unknown;
    previousHash: string | null;
    eventHash: string;
  }> {
    const rows = await db.sql<
      {
        event_id: string;
        sequence: string;
        previous_hash: string | null;
        event_hash: string;
        action_id: string | null;
        run_id: string | null;
        actor_type: string;
        actor_id: string;
        event_type: string;
        trace_id: string;
        policy_revision_id: string | null;
        payload_redacted_json: unknown;
        event_time: string;
      }[]
    >`
      SELECT event_id, sequence::text AS sequence, previous_hash, event_hash, action_id, run_id,
             actor_type, actor_id, event_type, trace_id, policy_revision_id, payload_redacted_json,
             event_time
        FROM audit_events WHERE tenant_id = ${TENANT()} ORDER BY sequence ASC`;
    const row = rows[sequence - 1];
    if (!row) throw new Error(`no audit row at sequence ${sequence}`);
    return {
      tenantId: TENANT(),
      eventId: row.event_id,
      actionId: row.action_id,
      runId: row.run_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      eventType: row.event_type,
      eventTime: new Date(row.event_time),
      traceId: row.trace_id,
      policyRevisionId: row.policy_revision_id,
      storedPayload: row.payload_redacted_json,
      previousHash: row.previous_hash,
      eventHash: row.event_hash,
    };
  }

  it('re-hashes a keyed row with the key that wrote it, over the plaintext', async () => {
    await appendAuditEvent(db.db, event(1));
    const row = await storedRow(1);

    // Re-link it onto a different predecessor, the way a purge does.
    const rehashed = reanchorAuditHash(row, 'sha256:' + '0'.repeat(64));

    // It is found at all — which means the key that wrote the row was
    // DISCOVERED rather than assumed.
    expect(rehashed).not.toBeNull();
    expect(rehashed?.version).toBe(AUDIT_HASH_VERSION_HMAC);

    // And the new hash is the one a reader with that key would compute
    // over the PLAINTEXT. Hashing the stored envelope instead — the obvious
    // implementation — produces a digest no verifier can reproduce, which
    // is how a retention purge used to break the chain it was re-anchoring.
    const expected = computeAuditHash(
      {
        tenantId: row.tenantId,
        eventId: row.eventId,
        actionId: row.actionId,
        runId: row.runId,
        actorType: row.actorType,
        actorId: row.actorId,
        eventType: row.eventType,
        eventTime: row.eventTime,
        traceId: row.traceId,
        policyRevisionId: row.policyRevisionId,
        payload: { n: 1, note: SECRET },
        previousHash: 'sha256:' + '0'.repeat(64),
      },
      TEST_KEY,
    );
    expect(rehashed?.hash).toBe(expected.hash);
  });

  it('re-hashes a plain row as plain, with no key at all', async () => {
    useKeyring(null);
    await appendAuditEvent(db.db, event(1));
    const row = await storedRow(1);

    const rehashed = reanchorAuditHash(row, 'sha256:' + '0'.repeat(64));
    expect(rehashed).not.toBeNull();
    expect(rehashed?.version).toBe(AUDIT_HASH_VERSION_PLAIN);
  });

  it('refuses a row that no key reproduces, rather than guessing', async () => {
    await appendAuditEvent(db.db, event(1));
    const row = await storedRow(1);

    // A row whose hash does not correspond to its contents is a row that
    // has been altered. Re-linking it would launder that into a
    // clean-looking chain, so the re-anchor refuses and says so.
    const tampered = { ...row, eventHash: 'sha256:' + 'f'.repeat(64) };
    expect(reanchorAuditHash(tampered, 'sha256:' + '0'.repeat(64))).toBeNull();
  });
});

describe('encryption at rest', () => {
  it('stores the audit payload as ciphertext, not as the payload', async () => {
    await appendAuditEvent(db.db, event(1));
    const rows = await db.sql<{ payload: string }[]>`
      SELECT payload_redacted_json::text AS payload FROM audit_events WHERE tenant_id = ${TENANT()}`;
    const stored = rows[0]?.payload ?? '';
    expect(stored).toContain('__pz_enc');
    expect(stored).toContain('enc.v1.');
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('beneficiary-ref');
  });

  it('still hands the caller the payload it wrote', async () => {
    const record = await appendAuditEvent(db.db, event(1));
    expect(record.payloadRedacted).toEqual({ n: 1, note: SECRET });
    const listed = await listAuditEvents(db.db, TENANT(), {}, { limit: 10 });
    expect(listed.rows[0]?.payloadRedacted).toEqual({ n: 1, note: SECRET });
  });

  it('verifies the chain of an encrypted payload', async () => {
    for (const n of [1, 2, 3]) await appendAuditEvent(db.db, event(n));
    const verification = await verifyAuditChain(db.db, TENANT());
    expect(verification).toMatchObject({ checked: 3, chainValid: true, breaks: [] });
  });

  it('stores the outbox payload as ciphertext too', async () => {
    await insertOutboxEvent(db.db, {
      tenantId: TENANT(),
      aggregateType: 'action',
      aggregateId: 'act_1',
      eventType: 'action.submitted',
      queueName: 'pz.outbox',
      payload: { action_id: 'act_1', note: SECRET },
    });
    const rows = await db.sql<{ payload: string }[]>`
      SELECT payload_json::text AS payload FROM outbox_events WHERE tenant_id = ${TENANT()}`;
    expect(rows[0]?.payload ?? '').not.toContain(SECRET);
    expect(rows[0]?.payload ?? '').toContain('__pz_enc');
  });

  it('fails verification when the stored ciphertext is altered', async () => {
    await appendAuditEvent(db.db, event(1));
    expect((await verifyAuditChain(db.db, TENANT())).chainValid).toBe(true);
    await tamperWithStoredPayload();
    const verification = await verifyAuditChain(db.db, TENANT());
    expect(verification.chainValid).toBe(false);
    expect(verification.breaks).toHaveLength(1);
    expect(verification.breaks[0]?.reason).toContain('authentication');
  });

  it('reads a payload written before encryption was enabled', async () => {
    // The legacy rule: a row that holds plaintext is read as plaintext. The
    // audit table is append-only, so such a row can never be rewritten — and
    // refusing to read it would turn a migration into an outage.
    await appendAuditEvent(db.db, event(1));
    const head = await db.sql<{ sequence: string; event_hash: string }[]>`
      SELECT sequence::text AS sequence, event_hash FROM audit_events
      WHERE tenant_id = ${TENANT()} ORDER BY sequence DESC LIMIT 1`;
    const previousHash = head[0]?.event_hash ?? null;
    const legacyPayload = { legacy: true, note: SECRET };
    const { hash, version } = computeAuditHash(
      {
        tenantId: TENANT(),
        eventId: 'aud_legacy_event',
        actionId: null,
        runId: null,
        actorType: 'SYSTEM',
        actorId: 'system:legacy',
        eventType: 'system.legacy_row',
        eventTime: new Date('2026-10-26T12:00:09Z'),
        traceId: 'trc_legacy',
        policyRevisionId: null,
        payload: legacyPayload,
        previousHash,
      },
      TEST_KEY,
    );
    await db.sql`
      INSERT INTO audit_events (
        event_id, tenant_id, actor_type, actor_id, event_type, event_time, trace_id,
        payload_redacted_json, previous_hash, event_hash, hash_version, sequence
      ) VALUES (
        'aud_legacy_event', ${TENANT()}, 'SYSTEM', 'system:legacy', 'system.legacy_row',
        '2026-10-26T12:00:09Z'::timestamptz, 'trc_legacy',
        ${JSON.stringify(legacyPayload)}::jsonb, ${previousHash}, ${hash}, ${version}, NULL
      )`;
    const verification = await verifyAuditChain(db.db, TENANT());
    expect(verification).toMatchObject({ checked: 2, chainValid: true, breaks: [] });
    const listed = await listAuditEvents(db.db, TENANT(), {}, { limit: 10 });
    const legacy = listed.rows.find((row) => row.eventId === 'aud_legacy_event');
    expect(legacy?.payloadRedacted).toEqual(legacyPayload);
  });
});

describe('decrypt refuses what it cannot trust', () => {
  const key = deriveKey(TEST_KEY, 'audit-payload');
  const other = deriveKey(OTHER_KEY, 'audit-payload');

  it('round-trips a value it encrypted itself', () => {
    expect(decrypt(encrypt('hello', key), key)).toBe('hello');
  });

  it('refuses a tampered ciphertext', () => {
    const envelope = encrypt('hello', key);
    const tampered = `${envelope.slice(0, -1)}${envelope.endsWith('A') ? 'B' : 'A'}`;
    expect(() => decrypt(tampered, key)).toThrow(DecryptionError);
    try {
      decrypt(tampered, key);
    } catch (err) {
      expect((err as DecryptionError).reason).toBe('UNAUTHENTICATED');
    }
  });

  it('refuses a wrong key', () => {
    expect(() => decrypt(encrypt('hello', key), other)).toThrow(DecryptionError);
    try {
      decrypt(encrypt('hello', key), other);
    } catch (err) {
      expect((err as DecryptionError).reason).toBe('UNAUTHENTICATED');
    }
  });

  it('refuses a malformed value', () => {
    for (const malformed of ['not-an-envelope', 'enc.v1.too.few', 'enc.v1.!!.!!.!!', 'enc.v2.aaaa.bbbb.cccc', '']) {
      expect(() => decrypt(malformed, key), malformed).toThrow(DecryptionError);
    }
    try {
      decrypt('not-an-envelope', key);
    } catch (err) {
      expect((err as DecryptionError).reason).toBe('MALFORMED');
    }
  });

  it('derives a different key for every purpose', () => {
    expect(deriveKey(TEST_KEY, 'audit-payload').equals(deriveKey(TEST_KEY, 'outbox-payload'))).toBe(false);
    expect(deriveKey(TEST_KEY, 'audit-payload').equals(deriveKey(OTHER_KEY, 'audit-payload'))).toBe(false);
  });
});
