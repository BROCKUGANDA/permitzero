/**
 * Concurrent claiming, against a real PostgreSQL.
 *
 * The existing lease tests in `execution-stores.test.ts` claim twice from one
 * connection in sequence, and the second claim sees nothing because the first
 * bumped `next_attempt_at`. That is the lease doing its job — but it also means
 * those tests would still pass if `FOR UPDATE SKIP LOCKED` were deleted: with the
 * row lock gone, two dispatchers race for the same row, both publish it, and every
 * sequential test stays green while production delivers twice.
 *
 * So this file holds a claim open inside a transaction on one connection and
 * claims on a second connection at the same time. Only the row lock makes the two
 * result sets disjoint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLAIM_LEASE_SECONDS,
  claimOutboxEvents,
  closeDb,
  createDb,
  insertOutboxEvent,
  resetDb,
  seed,
  type Db,
  type SeedResult,
} from '../src/index.js';
import { closeTestDb, testDb, testDbUrl } from './db-test.js';

let db: Db;
let seeded: SeedResult;

const now = new Date('2026-10-26T12:00:00Z');
const leaseMs = CLAIM_LEASE_SECONDS * 1000;

async function seedRows(count: number, tenantId: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    await insertOutboxEvent(db.db, {
      tenantId,
      aggregateType: 'action',
      aggregateId: `act_concurrent_${tenantId}_${i}`,
      eventType: 'action.submitted',
      queueName: 'pz.outbox',
      payload: { index: i },
    });
  }
}

/**
 * Clear only the outbox. `resetDb()` would also drop the tenants every row here
 * has a foreign key to, so the second test in the file would insert orphans.
 */
async function drainOutbox(): Promise<void> {
  await db.sql`TRUNCATE TABLE outbox_events RESTART IDENTITY`;
}

/**
 * Claim inside a transaction and hold it open until `release` resolves, so the
 * row locks are still held while a peer claims. Nothing else here produces real
 * contention.
 */
function claimHolding(target: Db, limit: number, release: Promise<void>) {
  return target.db.transaction(async (tx) => {
    const rows = await claimOutboxEvents(tx, limit, now);
    await release;
    return rows;
  });
}

const tenants = (): [string, string] => {
  const a = seeded.tenantIds[0];
  const b = seeded.tenantIds[1];
  if (!a || !b) throw new Error('seed must produce at least two tenants');
  return [a, b];
};

beforeAll(async () => {
  db = await testDb();
  await resetDb(db);
  seeded = await seed(db, { tenants: 3 });
});

afterAll(async () => {
  await closeTestDb();
});

describe('concurrent outbox claiming', () => {
  it('gives two simultaneous claimers disjoint rows, never the same row twice', async () => {
    const [tenantA] = tenants();
    await drainOutbox();
    await seedRows(20, tenantA);

    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    // A second pool: another session, another transaction, another row lock.
    const peer = createDb(testDbUrl(), { max: 1 });

    const claimingA = claimHolding(db, 10, hold);
    // Give A time to open its transaction and take the locks.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // B starts while A is still holding. The release has to happen out here, not
    // inside `claimingA.then(...)`: a callback on that promise runs only after A
    // resolves, and A resolves only once the hold is released — the first version
    // of this test deadlocked itself on exactly that circle.
    const claimingB = claimOutboxEvents(peer.db, 10, now);
    releaseHold();

    const [a, b] = await Promise.all([claimingA, claimingB]);
    await closeDb(peer);

    const idsA = a.map((r) => r.id);
    const idsB = b.map((r) => r.id);
    expect(idsA.length, 'claimer A saw nothing').toBeGreaterThan(0);
    expect(idsA.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(
      idsA.filter((id) => idsB.includes(id)),
      'both claimers were handed the same row',
    ).toEqual([]);
    expect(idsA.length + idsB.length).toBeLessThanOrEqual(20);
  });

  it('leaves every claimed-but-unpublished row pending, so a crash loses nothing', async () => {
    const [tenantA] = tenants();
    await drainOutbox();
    await seedRows(5, tenantA);

    // Claim and then die. The claim commits — that is the crash model: the claim
    // landed, the publish never happened — so the rows stay PENDING under a lease.
    const claimed = await claimOutboxEvents(db.db, 5, now);
    expect(claimed).toHaveLength(5);

    const stillPending = await db.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM outbox_events WHERE status = 'PENDING'`;
    expect(stillPending[0]?.n).toBe('5');

    // Inside the lease window nobody may re-claim: two workers publishing the same
    // event is the duplicate side effect this design exists to prevent.
    const tooEarly = await claimOutboxEvents(db.db, 5, new Date(now.getTime() + leaseMs / 2));
    expect(tooEarly).toHaveLength(0);

    // After the lease expires the row is claimable again, and the attempt count is
    // the evidence that it was already tried.
    const afterLease = await claimOutboxEvents(db.db, 5, new Date(now.getTime() + leaseMs + 5_000));
    expect(afterLease).toHaveLength(5);
    expect(afterLease.every((r) => r.attemptCount === 2)).toBe(true);
  });

  it('claims strictly oldest-first across tenants, so no row is passed over indefinitely', async () => {
    // The claim is one global age-ordered query rather than a per-tenant loop. A
    // loop that drained tenant A first would make B wait on A's backlog every
    // tick; ordering globally by age bounds any row's delay by queue depth over
    // batch size, whoever owns it. Asserting the ordering is what keeps that
    // argument from becoming a comment people trust.
    const [tenantA, tenantB] = tenants();
    await drainOutbox();
    // B's row goes in first, so it is the oldest thing in the queue.
    await seedRows(1, tenantB);
    await seedRows(9, tenantA);

    const batch = await claimOutboxEvents(db.db, 3, now);
    expect(batch).toHaveLength(3);
    expect(batch[0]?.tenantId).toBe(tenantB);

    // Compare ages with two plain queries rather than an ANY(ARRAY[...]) literal:
    // the driver binds JS arrays as scalar strings, which Postgres rejects as a
    // malformed array literal — the same trap recorded in repos/actions.ts.
    //
    // A claim is identified by `attempt_count`, not by `status`: claiming leaves a
    // row PENDING and only bumps the counter and the lease. Asserting on status
    // here would have found nothing and looked like a broken test rather than a
    // wrong assumption about the claim protocol.
    const claimed = await db.sql<{ oldest: string | null }[]>`
      SELECT max(created_at)::text AS oldest FROM outbox_events WHERE attempt_count > 0`;
    const remaining = await db.sql<{ youngest: string | null }[]>`
      SELECT min(created_at)::text AS youngest FROM outbox_events WHERE attempt_count = 0`;
    const oldestClaimed = claimed[0]?.oldest;
    const youngestLeft = remaining[0]?.youngest;
    expect(oldestClaimed, 'nothing was claimed').toBeTruthy();
    expect(youngestLeft, 'nothing was left behind').toBeTruthy();
    expect(new Date(oldestClaimed as string).getTime()).toBeLessThanOrEqual(new Date(youngestLeft as string).getTime());
  });

  it('claims across tenants in one statement, which is what the blind context is for', async () => {
    const [tenantA, tenantB] = tenants();
    await drainOutbox();
    await seedRows(2, tenantA);
    await seedRows(2, tenantB);
    const all = await claimOutboxEvents(db.db, 10, now);
    expect(all).toHaveLength(4);
    expect(new Set(all.map((r) => r.tenantId)).size).toBe(2);
  });
});
