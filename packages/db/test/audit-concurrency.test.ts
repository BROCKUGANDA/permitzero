/**
 * Concurrent appends to one tenant's audit chain, against a real PostgreSQL.
 *
 * `appendAuditEvent` is written as optimistic concurrency: read the head, hash the
 * new event over it, insert, and if the insert collides, re-read and try again
 * (five attempts). The chain trigger makes that retry necessary by serialising
 * writers per tenant — and makes it impossible in the shape the loop has, because a
 * failed statement aborts the whole transaction. The second attempt's `SELECT` does
 * not re-read the head; it fails with 25P02 ("current transaction is aborted"),
 * which is not one of the codes the loop catches, so it throws and the request
 * becomes a 500.
 *
 * That is invisible in a sequential test — one writer never collides — and it is
 * exactly what the load sweep surfaced: one 500 in ~1,900 requests at 25 concurrent
 * clients on a single tenant. So this file holds one transaction open across
 * another writer's head read, which is the only way to make the collision happen on
 * a schedule rather than by luck.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAuditEvent,
  closeDb,
  createDb,
  getAuditHead,
  resetDb,
  seed,
  verifyAuditChain,
  type Db,
  type SeedResult,
} from '../src/index.js';
import { closeTestDb, testDb, testDbUrl } from './db-test.js';

let db: Db;
let seeded: SeedResult;
let tenant: string;

/**
 * Flatten an error and its causes into one string.
 *
 * drizzle wraps the driver error, so the SQLSTATE and the constraint name both live
 * on `.cause`; `String(err)` alone shows only "Failed query: …", which is exactly the
 * message a user would see if the HTTP boundary passed it through, and precisely why
 * the assertions below need the whole chain.
 */
const describeError = (value: unknown): string => {
  const parts: string[] = [];
  let current: unknown = value;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth++) {
    const err = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof err.message === 'string') parts.push(err.message);
    if (typeof err.code === 'string') parts.push(err.code);
    current = err.cause;
  }
  return parts.join(' | ');
};

const settle = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason: describeError(reason) }),
  );

/**
 * Append inside a transaction that can be held open. `hold` is what creates the
 * collision: the first writer must still be uncommitted while the second reads the
 * chain head, which is the interleaving the retry loop assumes it can survive.
 */
function appendInTx(target: Db, tag: string, hold?: Promise<void>) {
  return target.db.transaction(async (tx) => {
    const record = await appendAuditEvent(tx, {
      tenantId: tenant,
      actorType: 'AGENT',
      actorId: `agent_${tag}`,
      eventType: 'action.submitted',
      traceId: `trace_${tag}`,
      payload: { tag },
    });
    if (hold) await hold;
    return Number(record.sequence);
  });
}

beforeAll(async () => {
  db = await testDb();
  await resetDb(db);
  seeded = await seed(db, { tenants: 1 });
  tenant = seeded.tenantIds[0] ?? '';
});

afterAll(async () => {
  await closeTestDb();
});

describe('concurrent audit appends', () => {
  it('does not lose the second writer when the chain head moves underneath it', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = appendInTx(db, 'first', gate);
    // The first transaction must have taken the chain lock and written its event
    // before the second reads the head, otherwise there is no collision to test.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const second = appendInTx(db, 'second');
    // Commit only after the second writer is provably committed to a head it read
    // while the first was still open. Releasing the gate immediately lets the
    // second transaction read the *new* head and win without ever colliding, which
    // is the shape this test had before and it passed for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseFirst();

    const firstSequence = await first;
    const outcome = await settle(second);

    // Before the fix this is a rejection carrying 25P02: the retry loop's second
    // attempt cannot run in a transaction its first attempt already aborted.
    expect(outcome.status, `second writer failed: ${outcome.status === 'rejected' ? outcome.reason : ''}`).toBe(
      'fulfilled',
    );
    if (outcome.status !== 'fulfilled') return;
    expect(outcome.value).toBe(firstSequence + 1);

    const head = await getAuditHead(db.db, tenant);
    expect(Number(head?.sequence)).toBe(firstSequence + 1);
    const chain = await verifyAuditChain(db.db, tenant);
    expect(chain.chainValid, `chain breaks: ${JSON.stringify(chain.breaks)}`).toBe(true);
  });

  it('serves every writer when a burst of them appends at once', async () => {
    // Ten concurrent transactions against one tenant is the shape the load sweep
    // runs, and the assertion is the one an operator would care about: nobody gets
    // a 500, and the chain comes out gapless rather than merely intact.
    const burst = createDb(testDbUrl(), { max: 12 });
    try {
      const before = Number((await getAuditHead(db.db, tenant))?.sequence ?? 0);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => settle(appendInTx(burst, `burst_${i}`))));
      const failures = results.filter((r) => r.status === 'rejected');
      expect(
        failures,
        `failed appends: ${failures.map((f) => (f.status === 'rejected' ? f.reason : '')).join(' | ')}`,
      ).toEqual([]);
      const sequences = results
        .filter((r): r is { status: 'fulfilled'; value: number } => r.status === 'fulfilled')
        .map((r) => r.value)
        .sort((a, b) => a - b);
      expect(sequences).toHaveLength(10);
      for (let i = 0; i < sequences.length; i++) {
        expect(sequences[i]).toBe(before + i + 1);
      }
      const chain = await verifyAuditChain(db.db, tenant);
      expect(chain.chainValid).toBe(true);
    } finally {
      await closeDb(burst);
    }
  });

  it('reports a row that breaks a CHECK as the violation it is, not as contention', async () => {
    // 'agent' is not one of USER / AGENT / SYSTEM / WORKER, so the insert fails a
    // real CHECK constraint on the table. The retry loop used to read any 23514 as
    // a chain collision, retry, and die on 25P02 — which turned a bad payload into
    // a 500 that never mentioned the constraint. The violation has to survive.
    const outcome = await settle(
      db.db.transaction((tx) =>
        appendAuditEvent(tx, {
          tenantId: tenant,
          actorType: 'agent' as never,
          actorId: 'agent_bad_row',
          eventType: 'action.submitted',
          traceId: 'trace_bad_row',
          payload: { tag: 'bad' },
        }),
      ),
    );
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toContain('chk_audit_events_actor_type');
    expect(outcome.reason, 'the constraint error was retried until the transaction aborted').not.toContain('25P02');
  });
});
