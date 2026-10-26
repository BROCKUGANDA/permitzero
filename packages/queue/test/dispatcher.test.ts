/**
 * Dispatcher tests: claimed rows reach the queue exactly as published jobs,
 * failures back off and eventually die loudly, and races report instead of
 * duplicating.
 */
import { describe, expect, it, vi } from 'vitest';
import { DomainError, ErrorCode } from '@permitzero/domain';
import { QUEUE_NAMES, createOutboxDispatcher, type DispatcherEvent, type OutboxRow, type OutboxStore, type QueueFactory, type QueueLike } from '../src/index.js';

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `obx_${Math.random().toString(36).slice(2)}`,
    tenantId: 'ten_test',
    eventType: 'action.decided',
    queueName: QUEUE_NAMES.outbox,
    payload: { action_id: 'act_1' },
    status: 'PENDING',
    attemptCount: 0,
    maxAttempts: 8,
    nextAttemptAt: null,
    lastErrorClass: null,
    createdAt: new Date('2026-10-26T12:00:00Z'),
    traceId: null,
    ...overrides,
  };
}

function makeStore(initial: OutboxRow[] = []): OutboxStore & { rows: OutboxRow[] } {
  const rows = initial;
  const byId = (id: string) => rows.find((r) => r.id === id);
  return {
    rows,
    claimPending: async (limit) => rows.filter((r) => r.status === 'PENDING' || r.status === 'FAILED').slice(0, limit),
    markPublished: async (id) => {
      const r = byId(id);
      if (!r || r.status === 'PUBLISHED') return false;
      r.status = 'PUBLISHED';
      return true;
    },
    markFailed: async (id, errorClass, nextAttemptAt) => {
      const r = byId(id);
      if (!r) return false;
      r.status = 'FAILED';
      r.lastErrorClass = errorClass;
      r.nextAttemptAt = nextAttemptAt;
      r.attemptCount += 1;
      return true;
    },
    markDead: async (id, errorClass) => {
      const r = byId(id);
      if (!r) return false;
      r.status = 'DEAD';
      r.lastErrorClass = errorClass;
      return true;
    },
    countByStatus: async () => ({ PENDING: 0, PUBLISHED: 0, FAILED: 0, DEAD: 0 }),
    redrive: async () => null,
    insert: async (draft) => {
      const created = row({ ...draft, id: `obx_${rows.length + 1}` });
      rows.push(created);
      return created;
    },
  };
}

interface AddedJob {
  jobName: string;
  data: unknown;
  opts?: Record<string, unknown>;
}

function makeQueues(failWith?: unknown): { factory: QueueFactory; added: AddedJob[] } {
  const added: AddedJob[] = [];
  return {
    added,
    factory: (name) => ({
      name,
      add: async (jobName: string, data: unknown, opts?: Record<string, unknown>) => {
        if (failWith !== undefined) throw failWith;
        added.push({ jobName, data, opts });
        return { id: `job_${added.length}` };
      },
      getJobCounts: async () => ({}),
      getJobs: async () => [],
      close: async () => undefined,
    }),
  };
}

describe('outbox dispatcher', () => {
  it('publishes claimed rows with deduplicating job ids', async () => {
    const store = makeStore([row({ id: 'obx_1' }), row({ id: 'obx_2' })]);
    const queues = makeQueues();
    const events: DispatcherEvent[] = [];
    const dispatcher = createOutboxDispatcher({ store, queues: queues.factory, onEvent: (e) => events.push(e) });

    const result = await dispatcher.drainOnce();
    expect(result).toEqual({ claimed: 2, published: 2, failed: 0, dead: 0 });
    expect(queues.added).toHaveLength(2);
    expect(queues.added[0]?.opts).toMatchObject({ jobId: 'outbox:obx_1', attempts: 5 });
    expect(queues.added[0]?.data).toMatchObject({ outboxId: 'obx_1', tenantId: 'ten_test' });
    expect(store.rows.every((r) => r.status === 'PUBLISHED')).toBe(true);
    expect(events.filter((e) => e.kind === 'published')).toHaveLength(2);
    expect(events).toContainEqual({ kind: 'tick', claimed: 2 });
  });

  it('backs off retryable queue failures', async () => {
    const store = makeStore([row({ id: 'obx_1' })]);
    const queues = makeQueues(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    const events: DispatcherEvent[] = [];
    const now = new Date('2026-10-26T12:00:00Z');
    const dispatcher = createOutboxDispatcher({
      store,
      queues: queues.factory,
      onEvent: (e) => events.push(e),
      now: () => now,
      random: () => 0.5,
      retryBaseMs: 1000,
      retryCapMs: 8000,
    });

    const result = await dispatcher.drainOnce();
    expect(result).toEqual({ claimed: 1, published: 0, failed: 1, dead: 0 });
    expect(store.rows[0]?.status).toBe('FAILED');
    expect(store.rows[0]?.lastErrorClass).toBe('QUEUE_CONNECTION_REFUSED');
    const next = store.rows[0]?.nextAttemptAt?.getTime() ?? 0;
    expect(next).toBeGreaterThan(now.getTime());
    expect(next).toBeLessThanOrEqual(now.getTime() + 8000);
    expect(events).toContainEqual({
      kind: 'publish_failed',
      outboxId: 'obx_1',
      errorClass: 'QUEUE_CONNECTION_REFUSED',
      attempt: 1,
      retryable: true,
    });
  });

  it('parks exhausted and non-retryable rows as dead', async () => {
    const store = makeStore([row({ id: 'obx_old', attemptCount: 7, maxAttempts: 8 })]);
    const queues = makeQueues(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    const events: DispatcherEvent[] = [];
    const dispatcher = createOutboxDispatcher({ store, queues: queues.factory, onEvent: (e) => events.push(e) });
    expect(await dispatcher.drainOnce()).toMatchObject({ dead: 1 });
    expect(store.rows[0]?.status).toBe('DEAD');
    expect(events).toContainEqual({ kind: 'dead', outboxId: 'obx_old', errorClass: 'QUEUE_CONNECTION_REFUSED' });

    const fatal = new DomainError('no such queue', { code: ErrorCode.INTERNAL, retryable: false });
    const store2 = makeStore([row({ id: 'obx_poison' })]);
    const queues2 = makeQueues(fatal);
    const dispatcher2 = createOutboxDispatcher({ store: store2, queues: queues2.factory });
    expect(await dispatcher2.drainOnce()).toMatchObject({ dead: 1 });
    expect(store2.rows[0]?.status).toBe('DEAD');
  });

  it('reports a lost publish race instead of duplicating', async () => {
    const store = makeStore([row({ id: 'obx_1' })]);
    store.markPublished = async () => false; // another dispatcher moved it first
    const queues = makeQueues();
    const events: DispatcherEvent[] = [];
    const dispatcher = createOutboxDispatcher({ store, queues: queues.factory, onEvent: (e) => events.push(e) });
    expect(await dispatcher.drainOnce()).toEqual({ claimed: 1, published: 0, failed: 1, dead: 0 });
    expect(events).toContainEqual({
      kind: 'publish_failed',
      outboxId: 'obx_1',
      errorClass: 'OUTBOX_ALREADY_CLAIMED',
      attempt: 1,
      retryable: false,
    });
  });

  it('reports claim failures and rethrows', async () => {
    const store = makeStore();
    store.claimPending = async () => {
      throw new Error('database is down');
    };
    const queues = makeQueues();
    const events: DispatcherEvent[] = [];
    const dispatcher = createOutboxDispatcher({ store, queues: queues.factory, onEvent: (e) => events.push(e) });
    await expect(dispatcher.drainOnce()).rejects.toThrow('database is down');
    expect(events).toContainEqual({ kind: 'claim_failed', errorClass: 'QUEUE_UNKNOWN_ERROR' });
  });

  it('starts and stops its poll loop', async () => {
    const store = makeStore();
    const queues = makeQueues();
    const dispatcher = createOutboxDispatcher({ store, queues: queues.factory, pollIntervalMs: 50 });
    expect(dispatcher.running).toBe(false);
    dispatcher.start();
    expect(dispatcher.running).toBe(true);
    await dispatcher.stop();
    expect(dispatcher.running).toBe(false);
    await dispatcher.stop();
  });

  it('honors a custom job-attempts budget', async () => {
    const store = makeStore([row({ id: 'obx_1' })]);
    const queues = makeQueues();
    const dispatcher = createOutboxDispatcher({ store, queues: queues.factory, jobAttempts: 3 });
    await dispatcher.drainOnce();
    expect(queues.added[0]?.opts).toMatchObject({ attempts: 3 });
  });
});
