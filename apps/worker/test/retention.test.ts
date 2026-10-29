/**
 * Retention: the window, the hold, and the chain.
 *
 * The assertions here are the ones the control actually has to survive:
 *
 *   · a row past the window is gone, a row inside it is not;
 *   · a tenant under a legal hold keeps everything, and the sweep says so
 *     rather than quietly doing nothing;
 *   · the audit chain STILL VERIFIES after a purge — this is the assertion
 *     that matters most, because a purge that breaks the chain leaves the
 *     audit trail reporting itself as tampered, which is worse than not
 *     purging at all;
 *   · the purge is recorded, so a deletion is answerable rather than
 *     invisible.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditEvents, verifyAuditChain } from '@permitzero/db';
import { closeTestDb, freshWorker, type WorkerFixture } from './helpers.js';
import { AUDIT_PURGE_EVENT_TYPE, runRetentionSweep } from '../src/retention.js';
import type { RetentionDeps } from '../src/retention.js';

let t: WorkerFixture;

const DAY_MS = 86_400_000;

/**
 * The retention window under test.
 *
 * `auditHmacKey` mirrors the ENVIRONMENT, not a fixed value: the seeded
 * chain is hashed with whatever key the deployment has, and a sweep that
 * re-anchored a keyed chain with no key would produce a chain the verifier
 * could not check. Passing `null` here while the environment carries a key
 * is how the sweep's key handling was wrong for so long: the test passed
 * locally (no key in the environment) and failed in CI (a key in the
 * environment).
 *
 * So the test states the same thing the deployment does — the key it was
 * given — and the sweep has to do the right thing with it.
 */
function retentionDeps(): RetentionDeps {
  return {
    db: t.db,
    config: {
      auditRetentionDays: 365,
      outboxRetentionDays: 30,
      auditHmacKey: process.env['AUDIT_HMAC_KEY'] ?? null,
      operatorId: 'test:retention',
    },
  };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/** An audit event at a chosen time. The chain assigns its own sequence. */
async function appendAudit(eventTime: Date, eventType = 'test.retention'): Promise<void> {
  await t.stores.audit.append({
    tenantId: t.tenantId,
    actionId: null,
    runId: 'retention-test',
    actorType: 'SYSTEM',
    actorId: 'test:retention',
    eventType,
    eventTime,
    traceId: 'trace-retention-test',
    policyRevisionId: null,
    payloadRedacted: { marker: eventType },
  });
}

/**
 * A delivery record with a chosen creation time.
 *
 * The backdating UPDATE is on the management pool, which is exempt from
 * row-level security — and the runtime role must never be able to do this,
 * which is the whole reason the sweep runs where it runs.
 */
async function insertOutbox(createdAt: Date): Promise<string> {
  const row = await t.stores.outbox.insert({
    tenantId: t.tenantId,
    eventType: 'test.retention',
    queueName: 'pz.outbox',
    payload: { action_id: 'act-retention' },
  });
  await t.db.sql`
    UPDATE outbox_events
       SET created_at = ${createdAt.toISOString()}
     WHERE tenant_id = ${t.tenantId}
       AND outbox_event_id = ${row.id}
  `;
  return row.id;
}

async function auditEventTypes(): Promise<string[]> {
  const rows = await t.db.sql<{ event_type: string }[]>`
    SELECT event_type FROM audit_events WHERE tenant_id = ${t.tenantId} ORDER BY sequence ASC
  `;
  return rows.map((r) => r.event_type);
}

async function outboxCount(): Promise<number> {
  const rows = await t.db.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM outbox_events WHERE tenant_id = ${t.tenantId}
  `;
  return Number(rows[0]?.n ?? '0');
}

async function auditCount(): Promise<number> {
  const rows = await t.db.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM audit_events WHERE tenant_id = ${t.tenantId}
  `;
  return Number(rows[0]?.n ?? '0');
}

beforeEach(async () => {
  t = await freshWorker();
});

afterAll(async () => {
  await closeTestDb();
});

describe('retention sweep', () => {
  it('purges rows past the window and keeps rows inside it', async () => {
    const oldEvent = daysAgo(400); // past the 365-day audit window
    const freshEvent = daysAgo(3); // well inside it
    await appendAudit(oldEvent, 'test.retention.expired');
    await appendAudit(freshEvent, 'test.retention.kept');

    const oldDelivery = await insertOutbox(daysAgo(40)); // past the 30-day outbox window
    const freshDelivery = await insertOutbox(daysAgo(2));

    const before = await auditCount();
    const result = await runRetentionSweep(retentionDeps());

    expect(result.auditRowsPurged).toBe(1);
    expect(result.outboxRowsPurged).toBe(1);

    const types = await auditEventTypes();
    expect(types).not.toContain('test.retention.expired');
    expect(types).toContain('test.retention.kept');

    const remaining = await t.db.sql<{ outbox_event_id: string }[]>`
      SELECT outbox_event_id FROM outbox_events WHERE tenant_id = ${t.tenantId}
    `;
    const ids = remaining.map((r) => r.outbox_event_id);
    expect(ids).not.toContain(oldDelivery);
    expect(ids).toContain(freshDelivery);

    // The chain grew by the marker, so the count is "before, minus the
    // expired row, plus the marker".
    expect(await auditCount()).toBe(before);
  });

  it('leaves the audit chain verifiable after a purge', async () => {
    await appendAudit(daysAgo(400), 'test.retention.expired');
    await appendAudit(daysAgo(3), 'test.retention.kept');

    const before = await verifyAuditChain(t.db.db, t.tenantId, { hmacKey: null });
    expect(before.chainValid).toBe(true);

    const result = await runRetentionSweep(retentionDeps());
    expect(result.auditRowsPurged).toBe(1);
    expect(result.auditRowsRelinked).toBeGreaterThan(0);

    // The point of the whole exercise: the trail must not report itself as
    // tampered because the retention sweep did its job.
    const after = await verifyAuditChain(t.db.db, t.tenantId, { hmacKey: null });
    expect(after.chainValid).toBe(true);
    expect(after.breaks).toEqual([]);
    expect(after.checked).toBeGreaterThan(0);

    // The sequence is gapless and starts at 1 again: the chain was
    // re-anchored, not left with a hole in it.
    const sequences = await t.db.sql<{ sequence: string }[]>`
      SELECT sequence::text AS sequence FROM audit_events WHERE tenant_id = ${t.tenantId} ORDER BY sequence ASC
    `;
    expect(sequences.map((r) => Number(r.sequence))).toEqual(sequences.map((_, index) => index + 1));
  });

  it('removes nothing for a tenant under a legal hold, and says so', async () => {
    await appendAudit(daysAgo(400), 'test.retention.expired');
    const oldDelivery = await insertOutbox(daysAgo(40));

    await t.db.sql`
      INSERT INTO legal_holds (legal_hold_id, tenant_id, reason, operator_id)
      VALUES ('lh-test-1', ${t.tenantId}, 'litigation hold', 'test:operator')
    `;

    const result = await runRetentionSweep(retentionDeps());

    expect(result.tenantsHeld).toBe(1);
    expect(result.auditRowsPurged).toBe(0);
    expect(result.outboxRowsPurged).toBe(0);
    expect(result.tenants[0]).toMatchObject({ tenantId: t.tenantId, outcome: 'held', legalHold: true });

    const types = await auditEventTypes();
    expect(types).toContain('test.retention.expired');
    const remaining = await t.db.sql<{ outbox_event_id: string }[]>`
      SELECT outbox_event_id FROM outbox_events WHERE tenant_id = ${t.tenantId}
    `;
    expect(remaining.map((r) => r.outbox_event_id)).toContain(oldDelivery);

    // The hold is on the record: the sweep's refusal is itself recorded.
    const runs = await t.db.sql<{ outcome: string; legal_hold: boolean }[]>`
      SELECT outcome, legal_hold FROM retention_runs WHERE tenant_id = ${t.tenantId}
    `;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'held', legal_hold: true });

    // Releasing the hold lets the next pass do the work.
    await t.db.sql`
      UPDATE legal_holds
         SET released_at = now(), release_reason = 'matter closed', release_operator_id = 'test:operator'
       WHERE legal_hold_id = 'lh-test-1'
    `;
    const second = await runRetentionSweep(retentionDeps());
    expect(second.auditRowsPurged).toBe(1);
    expect(second.outboxRowsPurged).toBe(1);
  });

  it('records what it purged', async () => {
    await appendAudit(daysAgo(400), 'test.retention.expired');
    await insertOutbox(daysAgo(40));

    const result = await runRetentionSweep(retentionDeps());

    const runs = await t.db.sql<
      {
        outcome: string;
        audit_rows_purged: number;
        outbox_rows_purged: number;
        audit_rows_relinked: number;
        audit_retention_days: number;
        outbox_retention_days: number;
        chain_boundary_hash: string | null;
        chain_head_after: string | null;
        operator_id: string;
      }[]
    >`
      SELECT outcome, audit_rows_purged, outbox_rows_purged, audit_rows_relinked,
             audit_retention_days, outbox_retention_days, chain_boundary_hash,
             chain_head_after, operator_id
        FROM retention_runs
       WHERE tenant_id = ${t.tenantId}
    `;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: 'purged',
      audit_rows_purged: 1,
      outbox_rows_purged: 1,
      audit_retention_days: 365,
      outbox_retention_days: 30,
      operator_id: 'test:retention',
    });
    // The chain boundary is recorded, and it is a hash — the record points at
    // the chain rather than restating it.
    expect(runs[0]?.chain_boundary_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(runs[0]?.chain_head_after).toMatch(/^sha256:[a-f0-9]{64}$/);

    // And the marker is inside the chain, so the deletion is in the trail
    // itself rather than only in a side table.
    const types = await auditEventTypes();
    expect(types).toContain(AUDIT_PURGE_EVENT_TYPE);

    const marker = await t.db.sql<{ purged_at: string | null }[]>`
      SELECT purged_at::text
        FROM audit_events
       WHERE tenant_id = ${t.tenantId}
         AND event_type = ${AUDIT_PURGE_EVENT_TYPE}
    `;
    expect(marker).toHaveLength(1);
    expect(marker[0]?.purged_at).not.toBeNull();

    // The marker's payload is read the way an application reads it — through
    // the repository, which decrypts. Reading the column directly would
    // return the ENCRYPTION ENVELOPE in a deployment with a key, and the
    // assertion would pass on the envelope's shape rather than on the
    // record's contents.
    const listed = await listAuditEvents(t.db.db, t.tenantId, { eventType: AUDIT_PURGE_EVENT_TYPE }, { limit: 10 });
    expect(listed.rows).toHaveLength(1);
    const payload = listed.rows[0]?.payloadRedacted as {
      purged_rows?: number;
      boundary_hash?: string;
    };
    expect(payload?.purged_rows).toBe(1);
    expect(payload?.boundary_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('refuses to purge a chain that is already broken, rather than laundering it', async () => {
    await appendAudit(daysAgo(400), 'test.retention.expired');
    await appendAudit(daysAgo(3), 'test.retention.kept');

    // A row whose hash does not match its contents. It cannot be produced by
    // rewriting a row — the append-only trigger refuses every content change
    // for every role, including the owner — but a row INSERTED with a hash
    // that was never computed over its payload slips past the chain trigger,
    // which checks the link and the sequence and not the digest itself. That
    // is the shape of the tampering the chain is supposed to catch.
    const head = await t.db.sql<{ event_hash: string }[]>`
      SELECT event_hash FROM audit_events WHERE tenant_id = ${t.tenantId} ORDER BY sequence DESC LIMIT 1
    `;
    const headHash = head[0]?.event_hash ?? '';
    await t.db.sql`
      INSERT INTO audit_events
        (event_id, tenant_id, event_type, actor_type, actor_id, trace_id,
         payload_redacted_json, event_hash, previous_hash, hash_version, event_time)
      VALUES
        ('auditEvent_tampered', ${t.tenantId}, 'test.retention.tampered', 'SYSTEM', 'test:attacker',
         'trace-tamper', '{"marker":"tampered"}'::jsonb, ${`sha256:${'0'.repeat(64)}`},
         ${headHash}, 'pz-audit-v1', now())
    `;

    const result = await runRetentionSweep(retentionDeps());

    expect(result.errors).toBe(0);
    expect(result.auditRowsPurged).toBe(0);
    expect(result.tenants[0]?.outcome).toBe('skipped');

    // Nothing was removed and the broken chain is still broken — visible, not
    // quietly rewritten into something that looks clean.
    const types = await auditEventTypes();
    expect(types).toContain('test.retention.expired');
    const verification = await verifyAuditChain(t.db.db, t.tenantId, { hmacKey: null });
    expect(verification.chainValid).toBe(false);
  });
});
