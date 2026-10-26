/**
 * BullMQ driver for the queue ports. The API server uses this when REDIS_URL
 * is set; without it the dispatcher does not run and /v1/status reports the
 * queue as disabled rather than pretending to drain it.
 */
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';
import type { QueueName } from './names.js';
import { QUEUE_NAMES } from './names.js';
import type { QueueFactory, QueueLike, RedisLike } from './types.js';
import type { QueueJob, WorkerFactory, WorkerLike } from './workers.js';

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

export function createBullmqHandles(redisUrl: string): BullMQHandles {
  // BullMQ refuses any other maxRetriesPerRequest; blocking commands must not time out client-side.
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  const queues = new Map<string, Queue>();

  const getQueue = (name: QueueName): Queue => {
    const existing = queues.get(name);
    if (existing) return existing;
    const created = new Queue(name, { connection });
    queues.set(name, created);
    return created;
  };

  const factory: QueueFactory = (name: QueueName): QueueLike => {
    const queue = getQueue(name);
    return {
      name,
      add: async (jobName: string, data: unknown, opts?: Record<string, unknown>) => {
        const job = await queue.add(jobName, data ?? {}, { ...(opts ?? {}) });
        return { id: job.id };
      },
      getJobCounts: async () => {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        return { ...counts };
      },
      getJobs: async (statuses, start?: number, end?: number) => {
        const jobs = await queue.getJobs(statuses, start ?? 0, end ?? 0);
        return jobs.map((j) => ({ timestamp: j.timestamp, addedOn: undefined }));
      },
      close: async () => {
        await queue.close();
      },
    };
  };

  return {
    factory,
    redis: connection,
    probeOutboxDepth: async () => {
      const queue = getQueue(QUEUE_NAMES.outbox);
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      const depth = (counts['waiting'] ?? 0) + (counts['active'] ?? 0) + (counts['delayed'] ?? 0);
      const oldest = await queue.getJobs(['waiting', 'delayed', 'active'], 0, 0);
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
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  const workers: Worker[] = [];

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
    };
  };

  return {
    factory,
    close: async () => {
      for (const worker of workers) {
        await worker.close().catch(() => undefined);
      }
      workers.length = 0;
      connection.disconnect();
    },
  };
}
