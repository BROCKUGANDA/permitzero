/**
 * The dispatcher's and the worker's failure paths.
 *
 * These are the behaviours that only show up when something is broken: the
 * queue backend is down, a publish never answers, a row was published by a
 * peer while this dispatcher still held the claim. Everything here is a
 * property of the WRAPPER rather than of Redis or PostgreSQL, so it is
 * asserted with fakes — a fake is what makes "the command never settles" and
 * "the command rejects" two different, reachable states.
 *
 * The theme is the same in every case: a failure must be visible and must not
 * destroy committed work. A dispatcher that fails silently is a dispatcher
 * that has stopped, and nothing in the process says so.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  QUEUE_NAMES,
  RedisCircuitBreaker,
  createOutboxDispatcher,
  createWorkers,
  type DispatcherEvent,
  type OutboxRow,
  type OutboxStore,
  type QueueFactory,
  type QueueJobSummary,
  type QueueLike,
  type WorkerEvent,
} from '../src/index.js';

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

function workingQueues(): { factory: QueueFactory } {
  return {
    factory: (name) => ({
      name,
      add: async () => ({ id: 'job_1' }),
      getJobCounts: async () => ({}),
      getJobs: async () => [],
      close: async () => undefined,
    }),
  };
}

describe('the dispatcher reports what it cannot do', () => {
  it('says something when the caller supplied no event sink', async () => {
    // The API builds its dispatcher without an `onEvent`, so the default sink
    // is the only thing standing between a delivery failure and silence.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = makeStore([row({ id: 'obx_1' })]);
      const queues: QueueFactory = (name) => ({
        name,
        add: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
        },
        getJobCounts: async () => ({}),
        getJobs: async () => [],
        close: async () => undefined,
      });
      const dispatcher = createOutboxDispatcher({ store, queues });
      await dispatcher.drainOnce();
      const logged = [...warn.mock.calls, ...error.mock.calls].map((call) => String(call[0])).join('\n');
      expect(logged, 'the failure was swallowed').toContain('publish_failed');
      expect(logged).toContain('obx_1');
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('emits an event when a pass fails outright', async () => {
    const events: DispatcherEvent[] = [];
    const store = makeStore();
    store.claimPending = async () => {
      throw new Error('database is down');
    };
    const dispatcher = createOutboxDispatcher({
      store,
      queues: workingQueues().factory,
      onEvent: (event) => events.push(event),
      pollIntervalMs: 10,
    });
    dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await dispatcher.stop();
    expect(events.some((e) => e.kind === 'claim_failed')).toBe(true);
    // The loop's catch used to be empty, so an error that escaped the drain
    // left no event, no log and no metric anywhere.
    expect(events.some((e) => e.kind === 'publish_failed')).toBe(true);
  });

  it('abandons a publish that never answers', async () => {
    const store = makeStore([row({ id: 'obx_hang' })]);
    const queues: QueueFactory = (name) => ({
      name,
      // A command against a dead Redis does not reject; it waits. This is the
      // promise that never settles, and the dispatcher must not wait with it.
      add: () => new Promise(() => undefined),
      getJobCounts: async () => ({}),
      getJobs: async () => [],
      close: async () => undefined,
    });
    const dispatcher = createOutboxDispatcher({ store, queues, publishTimeoutMs: 50 });
    const started = Date.now();
    const result = await dispatcher.drainOnce();
    expect(Date.now() - started, 'the dispatcher waited for a promise that never settles').toBeLessThan(2_000);
    expect(result).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    expect(store.rows[0]?.lastErrorClass).toBe('QUEUE_TIMEOUT');
    expect(store.rows[0]?.status).toBe('FAILED');
  });

  it('does not claim rows while the queue is known to be down', async () => {
    const store = makeStore([row({ id: 'obx_1' })]);
    const events: DispatcherEvent[] = [];
    const queues = workingQueues().factory;
    queues.available = () => false;
    const dispatcher = createOutboxDispatcher({ store, queues, onEvent: (event) => events.push(event) });
    const result = await dispatcher.drainOnce();
    // Claiming a row it cannot publish spends one of the row's attempts per
    // poll, so an outage longer than `maxAttempts` would park every
    // committed event as DEAD.
    expect(result.claimed).toBe(0);
    expect(store.rows[0]?.status).toBe('PENDING');
    expect(events).toContainEqual({ kind: 'queue_unavailable', errorClass: 'QUEUE_UNAVAILABLE' });
  });

  it('carries the row tenant into the status write', async () => {
    const seen: Array<{ id: string; tenantId?: string }> = [];
    const store = makeStore([row({ id: 'obx_1', tenantId: 'ten_other' })]);
    const original = store.markFailed;
    store.markFailed = async (id, errorClass, nextAttemptAt, tenantId) => {
      seen.push({ id, tenantId });
      return original(id, errorClass, nextAttemptAt);
    };
    const queues: QueueFactory = (name) => ({
      name,
      add: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      },
      getJobCounts: async () => ({}),
      getJobs: async () => [],
      close: async () => undefined,
    });
    const dispatcher = createOutboxDispatcher({ store, queues });
    await dispatcher.drainOnce();
    expect(seen).toEqual([{ id: 'obx_1', tenantId: 'ten_other' }]);
  });
});

describe('the redis circuit breaker', () => {
  it('opens after consecutive transport failures and refuses the next attempt', () => {
    const clock = 1_000;
    const breaker = new RedisCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 500, now: () => clock });
    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canAttempt()).toBe(false);
  });

  it('lets one probe through after the reset window, and closes on success', () => {
    let clock = 1_000;
    const breaker = new RedisCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 500, now: () => clock });
    breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(false);
    clock += 600;
    expect(breaker.canAttempt(), 'the breaker never let a probe through').toBe(true);
    expect(breaker.canAttempt(), 'half-open allows one attempt, not two').toBe(false);
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('reopens when the probe fails', () => {
    let clock = 1_000;
    const breaker = new RedisCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 500, now: () => clock });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    clock += 600;
    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canAttempt()).toBe(false);
  });
});

describe('the dead-letter sweep', () => {
  it('redrives a dead letter that has been waiting long enough', async () => {
    const redriven: Array<{ jobName: string; data: unknown }> = [];
    const audited: unknown[] = [];
    const dlqJobs: QueueJobSummary[] = [
      {
        id: 'dlq_1',
        name: 'dead_letter',
        data: {
          sourceQueue: QUEUE_NAMES.outbox,
          sourceJobId: 'job_1',
          jobName: 'action.decided',
          data: { action_id: 'act_1' },
          tenantId: 'ten_test',
          traceId: null,
          errorClass: 'CONNECTOR_TIMEOUT',
          attempts: 5,
          deadLetteredAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
      },
    ];
    const dlq: QueueLike = {
      name: QUEUE_NAMES.deadLetter,
      add: async (jobName, data) => {
        redriven.push({ jobName, data });
        return { id: 'dlq_marker' };
      },
      getJobCounts: async () => ({}),
      getJobs: async () => dlqJobs,
      close: async () => undefined,
    };
    const target: QueueLike = {
      name: QUEUE_NAMES.outbox,
      add: async (jobName, data) => {
        redriven.push({ jobName, data });
        return { id: 'job_2' };
      },
      getJobCounts: async () => ({}),
      getJobs: async () => [],
      close: async () => undefined,
    };
    const events: WorkerEvent[] = [];
    const workers = createWorkers({
      queues: [QUEUE_NAMES.outbox],
      handlers: { [QUEUE_NAMES.outbox]: async () => ({ outcome: 'DONE' }) },
      workerFactory: (queue) => ({
        start: () => undefined,
        stop: async () => undefined,
        close: async () => undefined,
        process: () => undefined,
        queue: target,
      }),
      dlq,
      audit: {
        append: async (event) => {
          audited.push(event);
        },
      },
      dlqSweep: { intervalMs: 20, redriveAfterMs: 0, batchSize: 5 },
      onEvent: (event) => events.push(event),
    });
    workers.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await workers.stop();

    // One redrive onto the source queue, one marker on the dead-letter queue,
    // and an audit record — the redrive is an audited act, not a silent retry.
    expect(redriven.map((r) => r.jobName)).toContain('action.decided');
    expect(redriven.map((r) => r.jobName)).toContain('redriven');
    expect(audited).toHaveLength(1);
    expect(events.some((e) => e.kind === 'dlq_redriven')).toBe(true);
  });

  it('leaves a dead letter that is still too fresh alone', async () => {
    const redriven: string[] = [];
    const dlq: QueueLike = {
      name: QUEUE_NAMES.deadLetter,
      add: async (jobName) => {
        redriven.push(jobName);
        return { id: 'dlq_marker' };
      },
      getJobCounts: async () => ({}),
      getJobs: async () => [
        {
          id: 'dlq_1',
          name: 'dead_letter',
          data: {
            sourceQueue: QUEUE_NAMES.outbox,
            sourceJobId: 'job_1',
            jobName: 'action.decided',
            data: {},
            tenantId: 'ten_test',
            traceId: null,
            errorClass: 'X',
            attempts: 5,
            deadLetteredAt: new Date().toISOString(),
          },
        },
      ],
      close: async () => undefined,
    };
    const workers = createWorkers({
      queues: [QUEUE_NAMES.outbox],
      handlers: { [QUEUE_NAMES.outbox]: async () => ({ outcome: 'DONE' }) },
      workerFactory: (queue) => ({
        start: () => undefined,
        stop: async () => undefined,
        close: async () => undefined,
        process: () => undefined,
        queue: {
          name: QUEUE_NAMES.outbox,
          add: async (jobName) => {
            redriven.push(jobName);
            return { id: 'job_2' };
          },
          getJobCounts: async () => ({}),
          getJobs: async () => [],
          close: async () => undefined,
        },
      }),
      dlq,
      audit: { append: async () => undefined },
      dlqSweep: { intervalMs: 20, redriveAfterMs: 3_600_000, batchSize: 5 },
    });
    workers.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await workers.stop();
    expect(redriven, 'the sweep redrove a dead letter that was still fresh').toEqual([]);
  });
});
