/**
 * BullMQ driver for the queue ports. The API server uses this when REDIS_URL
 * is set; without it the dispatcher does not run and /v1/status reports the
 * queue as disabled rather than pretending to drain it.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { QueueName } from './names.js';
import { QUEUE_NAMES } from './names.js';
import type { QueueFactory, QueueLike, RedisLike } from './types.js';

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
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true });
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
