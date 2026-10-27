/**
 * Worker composition: the outbox dispatcher, the queue consumers and the
 * database sweeps. Queue wiring is optional — without Redis the process runs
 * the sweeps alone and says so, matching what the API reports on /v1/status.
 */
import { createBroker } from '@permitzero/db';
import type { Db } from '@permitzero/db';
import { QUEUE_NAMES, adaptDbAudit, adaptDbOutbox, createOutboxDispatcher, createWorkers } from '@permitzero/queue';
import type { OutboxDispatcher, QueueFactory, RedisLike, WorkerFactory, Workers } from '@permitzero/queue';
import type { WorkerConfig } from './config.js';
import { createOutboxRouter } from './handlers/outbox-events.js';
import { createReconciliationHandler } from './handlers/reconcile.js';
import { sweepExpiredApprovals, sweepUnknownOutcomes } from './sweeps.js';
import type { ExpirySweepResult, ReconcileSweepResult } from './sweeps.js';

export interface WorkerQueues {
  factory: QueueFactory;
  workerFactory: WorkerFactory;
  redis: RedisLike;
}

export interface BuildWorkerDeps {
  db: Db;
  config: WorkerConfig;
  queues?: WorkerQueues;
  clock?: () => Date;
}

export interface SweepReport {
  expiry: ExpirySweepResult;
  reconcile: ReconcileSweepResult;
}

export interface DrainReport {
  claimed: number;
  published: number;
  failed: number;
  dead: number;
}

export interface BuiltWorker {
  dispatcher: OutboxDispatcher | null;
  consumers: Workers | null;
  start: () => void;
  stop: () => Promise<void>;
  sweepOnce: () => Promise<SweepReport>;
  drainOnce: () => Promise<DrainReport | null>;
}

export function buildWorker(deps: BuildWorkerDeps): BuiltWorker {
  const clock = deps.clock ?? (() => new Date());
  const { broker, stores } = createBroker(deps.db, {
    signingKey: deps.config.permitSigningKey,
    signingKeyId: deps.config.permitSigningKeyId,
    auditHmacKey: deps.config.auditHmacKey,
    clock,
  });

  let dispatcher: OutboxDispatcher | null = null;
  let consumers: Workers | null = null;
  if (deps.queues) {
    dispatcher = createOutboxDispatcher({
      store: adaptDbOutbox(stores.outbox, clock),
      queues: deps.queues.factory,
      pollIntervalMs: deps.config.dispatchPollMs,
      batchSize: deps.config.dispatchBatchSize,
      jobAttempts: deps.config.jobAttempts,
      now: clock,
      onEvent: (event) => {
        if (event.kind === 'tick' && event.claimed === 0) return;
        console.log(`[worker:dispatch] ${JSON.stringify(event)}`);
      },
    });
    consumers = createWorkers({
      queues: [QUEUE_NAMES.outbox, QUEUE_NAMES.reconciliation],
      workerFactory: deps.queues.workerFactory,
      maxAttempts: deps.config.jobAttempts,
      concurrency: deps.config.workerConcurrency,
      dlq: deps.queues.factory(QUEUE_NAMES.deadLetter),
      audit: adaptDbAudit(stores.audit, clock),
      handlers: {
        [QUEUE_NAMES.outbox]: createOutboxRouter(),
        [QUEUE_NAMES.reconciliation]: createReconciliationHandler({ db: deps.db, broker }),
      },
      onEvent: (event) => console.log(`[worker:consume] ${JSON.stringify(event)}`),
    });
  }

  const sweepOnce = async (): Promise<SweepReport> => {
    const expiry = await sweepExpiredApprovals(
      { db: deps.db, stores, broker, clock },
      { limit: deps.config.sweepBatchSize },
    );
    const reconcile = await sweepUnknownOutcomes(
      { db: deps.db, stores, broker, clock },
      { limit: deps.config.sweepBatchSize, graceMs: deps.config.reconcileGraceMs },
    );
    if (
      expiry.expired > 0 ||
      reconcile.succeeded + reconcile.failed + reconcile.manual > 0 ||
      expiry.errors + reconcile.errors > 0
    ) {
      console.log(`[worker:sweep] ${JSON.stringify({ expiry, reconcile })}`);
    }
    return { expiry, reconcile };
  };

  let timer: NodeJS.Timeout | null = null;
  let sweeping = false;

  return {
    dispatcher,
    consumers,
    start: () => {
      dispatcher?.start();
      consumers?.start();
      if (timer) return;
      timer = setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        sweepOnce()
          .catch((err: unknown) => {
            console.error(`[worker:sweep] pass failed: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => {
            sweeping = false;
          });
      }, deps.config.sweepIntervalMs);
    },
    stop: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await consumers?.stop().catch(() => undefined);
      await dispatcher?.stop().catch(() => undefined);
      await consumers?.close().catch(() => undefined);
    },
    sweepOnce,
    drainOnce: async () => (dispatcher ? dispatcher.drainOnce() : null),
  };
}
