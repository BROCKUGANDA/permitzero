/**
 * Worker lifecycle: sweeps-only mode without Redis, full dispatch + consume
 * with queue fakes, and clean start/stop in both.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getAction, insertOutboxEvent } from '@permitzero/db';
import type { QueueFactory, QueueJob, QueueLike, WorkerFactory } from '@permitzero/queue';
import { buildWorker } from '../src/worker.js';
import {
  closeTestDb,
  connectorIdForTool,
  executionRecord,
  freshWorker,
  makeAction,
  testWorkerConfig,
  walkTo,
  type WorkerFixture,
} from './helpers.js';

let t: WorkerFixture;

beforeEach(async () => {
  t = await freshWorker();
});

afterAll(async () => {
  await closeTestDb();
});

interface AddedJob {
  queue: string;
  jobName: string;
  data: unknown;
  opts?: Record<string, unknown>;
}

function fakeQueues(): { factory: QueueFactory; added: AddedJob[] } {
  const added: AddedJob[] = [];
  const factory: QueueFactory = (name) => {
    const queue: QueueLike = {
      name,
      add: async (jobName: string, data: unknown, opts?: Record<string, unknown>) => {
        added.push({ queue: name, jobName, data, opts });
        return { id: `job_${added.length}` };
      },
      getJobCounts: async () => ({}),
      getJobs: async () => [],
      close: async () => undefined,
    };
    return queue;
  };
  return { factory, added };
}

function fakeWorkers(): {
  factory: WorkerFactory;
  processors: Map<string, (job: QueueJob) => Promise<void>>;
  started: string[];
} {
  const processors = new Map<string, (job: QueueJob) => Promise<void>>();
  const started: string[] = [];
  const factory: WorkerFactory = (queue, _opts) => ({
    start: () => {
      started.push(queue);
    },
    stop: async () => undefined,
    close: async () => undefined,
    process: (fn) => {
      processors.set(queue, fn);
    },
  });
  return { factory, processors, started };
}

describe('worker lifecycle', () => {
  it('runs sweeps-only without Redis', async () => {
    const built = buildWorker({ db: t.db, config: testWorkerConfig() });
    expect(built.dispatcher).toBeNull();
    expect(built.consumers).toBeNull();
    built.start();
    expect(await built.drainOnce()).toBeNull();
    const report = await built.sweepOnce();
    expect(report).toMatchObject({ expiry: { checked: 0 }, reconcile: { checked: 0 } });
    await built.stop();
    await built.stop();
  });

  it('dispatches claimed rows to the queue', async () => {
    const queues = fakeQueues();
    const workers = fakeWorkers();
    const built = buildWorker({
      db: t.db,
      config: testWorkerConfig(),
      queues: {
        factory: queues.factory,
        workerFactory: workers.factory,
        redis: { status: 'ready', ping: async () => 'PONG' },
      },
    });
    const row = await insertOutboxEvent(t.db.db, {
      tenantId: t.tenantId,
      aggregateType: 'action',
      aggregateId: 'act_1',
      eventType: 'action.decided',
      queueName: 'pz.outbox',
      payload: { action_id: 'act_1' },
      traceId: null,
    });
    const drained = await built.drainOnce();
    expect(drained).toMatchObject({ claimed: 1, published: 1 });
    expect(queues.added).toHaveLength(1);
    expect(queues.added[0]).toMatchObject({
      queue: 'pz.outbox',
      jobName: 'action.decided',
      opts: { jobId: `outbox:${row.outboxEventId}` },
    });
    await built.stop();
  });

  it('consumes reconciliation jobs through the wrapper', async () => {
    const queues = fakeQueues();
    const workers = fakeWorkers();
    const built = buildWorker({
      db: t.db,
      config: testWorkerConfig(),
      queues: {
        factory: queues.factory,
        workerFactory: workers.factory,
        redis: { status: 'ready', ping: async () => 'PONG' },
      },
    });
    built.start();
    expect(workers.started).toContain('pz.outbox');
    expect(workers.started).toContain('pz.reconciliation');

    const actionId = await makeAction(t, 'life-reconcile');
    await walkTo(t, actionId, [
      'VALIDATING',
      'EVALUATING',
      'ALLOWED',
      'PERMIT_ISSUED',
      'EXECUTION_PENDING',
      'EXECUTING',
      'UNKNOWN_OUTCOME',
    ]);
    const connectorId = await connectorIdForTool(t);
    await t.stores.executions.recordIntent(executionRecord(t, actionId, connectorId));
    const row = await insertOutboxEvent(t.db.db, {
      tenantId: t.tenantId,
      aggregateType: 'execution',
      aggregateId: 'exe_1',
      eventType: 'execution.unknown_outcome',
      queueName: 'pz.reconciliation',
      payload: { action_id: actionId },
      traceId: null,
    });

    const processor = workers.processors.get('pz.reconciliation');
    expect(processor).toBeDefined();
    await processor?.({
      id: 'job_1',
      name: 'execution.unknown_outcome',
      queue: 'pz.reconciliation',
      data: { outboxId: row.outboxEventId, tenantId: t.tenantId, eventType: 'execution.unknown_outcome' },
      attempt: 1,
      tenantId: t.tenantId,
      traceId: null,
    });
    // Never dispatched: reconciliation calls it failed, truthfully.
    expect((await getAction(t.db.db, t.tenantId, actionId))?.state).toBe('FAILED_TERMINAL');
    expect(built.consumers?.counts['completed']).toBe(1);
    await built.stop();
  });
});
