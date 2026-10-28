/**
 * BullMQ driver for the queue ports. The API server uses this when REDIS_URL
 * is set; without it the dispatcher does not run and /v1/status reports the
 * queue as disabled rather than pretending to drain it.
 */
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';
import type { RedisOptions } from 'ioredis';
import type { QueueName } from './names.js';
import { QUEUE_NAMES } from './names.js';
import type { QueueFactory, QueueJobSummary, QueueLike, RedisLike } from './types.js';
import { QueueCircuitOpenError } from './types.js';
import type { QueueJob, WorkerFactory, WorkerLike } from './workers.js';
import { RedisCircuitBreaker, isTransportFailure } from './circuit.js';
import { withDeadline } from './deadline.js';

export interface QueueDepth {
  depth: number;
  oldestJobAgeMs: number | null;
}

export interface BullMQHandles {
  factory: QueueFactory;
  redis: RedisLike;
  /** Depth of the outbox queue for /v1/status. Throws when Redis is down. */
  probeOutboxDepth: () => Promise<QueueDepth>;
  close: () => Promise<void>;
}

/**
 * How long a single Redis command may take before it is abandoned.
 *
 * The client-level `commandTimeout` only covers a command that was actually
 * written to the socket. The command that never gets written — issued while
 * the connection is down, or queued behind a reconnect — is what hangs a
 * dispatcher, so the deadline has to sit above the client, not inside it.
 */
export const REDIS_COMMAND_DEADLINE_MS = 5_000;

/** How long the client waits for the socket to come up. */
const REDIS_CONNECT_TIMEOUT_MS = 5_000;

/**
 * The producer connection.
 *
 * `maxRetriesPerRequest: null` is a BullMQ requirement for the *worker*
 * connection, because a blocking command must not time out client-side while
 * it waits. The producer has no blocking commands, and inheriting that setting
 * is what made a Redis outage invisible: `queue.add()` never rejected, it
 * waited on a promise that only settles when the server returns, so the
 * dispatcher awaited forever, its in-flight guard never cleared, and dispatch
 * stopped — permanently and without an error.
 *
 * So the producer gets a bounded retry count, no offline queue (a command
 * issued while disconnected fails immediately instead of being buffered for
 * later), and explicit connect and command timeouts.
 */
function producerConnectionOptions(): RedisOptions {
  return {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_COMMAND_DEADLINE_MS,
    // Reconnect, but back off: a Redis that is down should not be hammered
    // once per poll by every replica.
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  };
}

/** The worker connection: BullMQ's blocking commands need unbounded retries. */
function workerConnectionOptions(): RedisOptions {
  return { maxRetriesPerRequest: null, enableReadyCheck: true };
}

export function createBullmqHandles(redisUrl: string): BullMQHandles {
  const connection = new IORedis(redisUrl, producerConnectionOptions());
  const breaker = new RedisCircuitBreaker();
  const queues = new Map<string, Queue>();

  /**
   * One command, behind a deadline and the breaker.
   *
   * Both halves matter and they do different jobs. The deadline turns "the
   * server never answered" into a rejection the retry policy understands. The
   * breaker stops the dispatcher from asking a server it already knows is not
   * there — without it, every poll spends a deadline waiting and every row it
   * claimed loses an attempt.
   */
  const guarded = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    if (!breaker.canAttempt()) {
      throw new QueueCircuitOpenError(`Redis circuit breaker is open; ${label} was refused.`);
    }
    try {
      const result = await withDeadline(work(), REDIS_COMMAND_DEADLINE_MS, label);
      breaker.recordSuccess();
      return result;
    } catch (err) {
      if (isTransportFailure(err)) breaker.recordFailure();
      else breaker.recordSuccess();
      throw err;
    }
  };

  const getQueue = (name: QueueName): Queue => {
    const existing = queues.get(name);
    if (existing) return existing;
    const created = new Queue(name, { connection });
    queues.set(name, created);
    return created;
  };

  const toQueueLike = (queue: Queue): QueueLike => ({
    name: queue.name,
    add: async (jobName: string, data: unknown, opts?: Record<string, unknown>) => {
      const job = await guarded(`queue.add(${queue.name})`, () => queue.add(jobName, data ?? {}, { ...(opts ?? {}) }));
      return { id: job.id };
    },
    getJobCounts: async () => {
      const counts = await guarded(`queue.getJobCounts(${queue.name})`, () =>
        queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      );
      return { ...counts };
    },
    getJobs: async (statuses, start?: number, end?: number) => {
      const jobs = await guarded(`queue.getJobs(${queue.name})`, () => queue.getJobs(statuses, start ?? 0, end ?? 0));
      return jobs.map((j): QueueJobSummary => ({
        id: j.id,
        name: j.name,
        timestamp: j.timestamp,
        data: j.data,
      }));
    },
    // Removing a job is how the dead-letter sweep retires a dead letter it
    // has already redriven, so the source is no longer eligible for another
    // attempt. Without it the sweep's durable marker still prevents a second
    // redrive, but the dead-letter queue accumulates one marker per redrive
    // forever — and once the queue reaches the sweep's scan limit, the sweep
    // stops redriving entirely.
    //
    // A job that has already been removed is not an error: the caller's
    // intent — "this job should not be here" — is satisfied either way.
    remove: async (jobId: string) => {
      const job = await guarded(`queue.getJob(${queue.name})`, () => queue.getJob(jobId));
      if (!job) return false;
      await guarded(`queue.remove(${queue.name})`, () => job.remove());
      return true;
    },
    close: async () => {
      await queue.close();
    },
  });

  const factory: QueueFactory = (name: QueueName): QueueLike => toQueueLike(getQueue(name));
  // The dispatcher's guard against claiming what it cannot publish. The
  // connection's own status is the honest signal — it leaves `ready` the
  // moment the server stops answering — and the breaker adds the memory of a
  // server that answers but does not deliver.
  factory.available = () => connection.status === 'ready' && !breaker.isOpen();

  return {
    factory,
    redis: {
      get status(): string {
        return connection.status;
      },
      // Bounded for the same reason as everything else: /v1/status asks Redis
      // whether it is up, and that question must be answerable in milliseconds
      // when the answer is "no".
      ping: async () => withDeadline(connection.ping(), REDIS_COMMAND_DEADLINE_MS, 'redis.ping'),
    },
    probeOutboxDepth: async () => {
      const queue = getQueue(QUEUE_NAMES.outbox);
      const counts = await guarded('outbox.getJobCounts', () => queue.getJobCounts('waiting', 'active', 'delayed'));
      const depth = (counts['waiting'] ?? 0) + (counts['active'] ?? 0) + (counts['delayed'] ?? 0);
      const oldest = await guarded('outbox.getJobs', () => queue.getJobs(['waiting', 'delayed', 'active'], 0, 0));
      const timestamp = oldest[0]?.timestamp;
      return {
        depth,
        oldestJobAgeMs: typeof timestamp === 'number' ? Math.max(0, Date.now() - timestamp) : null,
      };
    },
    close: async () => {
      for (const queue of queues.values()) {
        await queue.close().catch(() => undefined);
      }
      queues.clear();
      connection.disconnect();
    },
  };
}

export interface BullMQWorkerHandles {
  factory: WorkerFactory;
  close: () => Promise<void>;
}

/**
 * BullMQ implementation of the `WorkerLike` port. Workers are built paused
 * (`autorun: false`) so no job can arrive before the wrapper registers its
 * processor; `start()` begins the poll.
 */
export function createBullmqWorkerFactory(redisUrl: string): BullMQWorkerHandles {
  const connection = new IORedis(redisUrl, workerConnectionOptions());
  // A second connection, for the other direction of travel. The dead-letter
  // redrive enqueues work, and enqueueing is a producer operation: it must
  // fail fast when Redis is down instead of waiting on a promise that never
  // settles. The worker connection cannot be that connection — BullMQ
  // requires `maxRetriesPerRequest: null` on it, which is exactly the setting
  // that makes a command wait forever.
  const producer = new IORedis(redisUrl, producerConnectionOptions());
  const breaker = new RedisCircuitBreaker();
  const workers: Worker[] = [];
  const producerQueues = new Map<string, Queue>();

  const guarded = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    if (!breaker.canAttempt()) {
      throw new QueueCircuitOpenError(`Redis circuit breaker is open; ${label} was refused.`);
    }
    try {
      const result = await withDeadline(work(), REDIS_COMMAND_DEADLINE_MS, label);
      breaker.recordSuccess();
      return result;
    } catch (err) {
      if (isTransportFailure(err)) breaker.recordFailure();
      else breaker.recordSuccess();
      throw err;
    }
  };

  /**
   * The producer handle for a queue the worker consumes.
   *
   * It exists for the dead-letter redrive: a dead letter has to go back to the
   * queue it came from, and the only handle on that queue is the one the
   * worker already owns.
   */
  const producerQueue = (name: QueueName): Queue => {
    const existing = producerQueues.get(name);
    if (existing) return existing;
    const created = new Queue(name, { connection: producer });
    producerQueues.set(name, created);
    return created;
  };

  const factory: WorkerFactory = (queue: QueueName, opts: { concurrency: number }): WorkerLike => {
    let processor: ((job: QueueJob) => Promise<void>) | null = null;
    const worker = new Worker(
      queue,
      async (job: Job) => {
        if (!processor) return;
        const data = (job.data ?? {}) as Record<string, unknown>;
        await processor({
          id: job.id ?? `${queue}:${job.name}:${job.attemptsMade}`,
          name: job.name ?? 'unknown',
          queue,
          data,
          attempt: job.attemptsMade + 1,
          tenantId: typeof data['tenantId'] === 'string' ? (data['tenantId'] as string) : null,
          traceId: typeof data['traceId'] === 'string' ? (data['traceId'] as string) : null,
        });
      },
      { connection, concurrency: opts.concurrency, autorun: false },
    );
    workers.push(worker);
    const redriveTarget = producerQueue(queue);
    return {
      start: () => {
        worker.run().catch(() => undefined);
      },
      stop: async () => {
        await worker.pause().catch(() => undefined);
      },
      close: async () => {
        await worker.close().catch(() => undefined);
      },
      process: (fn: (job: QueueJob) => Promise<void>) => {
        processor = fn;
      },
      queue: {
        name: redriveTarget.name,
        add: async (jobName: string, data: unknown, opts?: Record<string, unknown>) => {
          const job = await guarded(`redrive.add(${redriveTarget.name})`, () =>
            redriveTarget.add(jobName, data ?? {}, { ...(opts ?? {}) }),
          );
          return { id: job.id };
        },
        getJobCounts: async () => {
          const counts = await guarded(`redrive.getJobCounts(${redriveTarget.name})`, () =>
            redriveTarget.getJobCounts('waiting', 'active', 'delayed', 'failed'),
          );
          return { ...counts };
        },
        getJobs: async (statuses, start?: number, end?: number) => {
          const jobs = await guarded(`redrive.getJobs(${redriveTarget.name})`, () =>
            redriveTarget.getJobs(statuses, start ?? 0, end ?? 0),
          );
          return jobs.map((j): QueueJobSummary => ({
            id: j.id,
            name: j.name,
            timestamp: j.timestamp,
            data: j.data,
          }));
        },
        close: async () => {
          await redriveTarget.close();
        },
      },
    };
  };

  return {
    factory,
    close: async () => {
      for (const worker of workers) {
        await worker.close().catch(() => undefined);
      }
      workers.length = 0;
      for (const queue of producerQueues.values()) {
        await queue.close().catch(() => undefined);
      }
      producerQueues.clear();
      producer.disconnect();
      connection.disconnect();
    },
  };
}
