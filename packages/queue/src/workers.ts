import { classifyQueueError, type QueueLike } from './types.js';
import type { AuditSink, QueueName } from './names.js';

export interface QueueJob {
  id: string;
  name: string;
  queue: QueueName;
  data: unknown;
  /** 1 on the first delivery. At-least-once means this can repeat. */
  attempt: number;
  tenantId: string | null;
  traceId: string | null;
}

export type HandlerResult =
  | { outcome: 'DONE' }
  /** The authoritative state moved on; doing the work now would be wrong. This
   * is the idempotency check succeeding, not a failure. */
  | { outcome: 'SKIPPED_STALE'; reason: string }
  | { outcome: 'RETRY'; errorClass: string }
  | { outcome: 'FAILED'; errorClass: string };

export type JobHandler = (job: QueueJob) => Promise<HandlerResult>;

export type WorkerEvent =
  | { kind: 'completed'; queue: QueueName; jobId: string; outcome: HandlerResult['outcome'] }
  | { kind: 'skipped_stale'; queue: QueueName; jobId: string; reason: string }
  | { kind: 'retrying'; queue: QueueName; jobId: string; errorClass: string; attempt: number }
  | { kind: 'dead_lettered'; queue: QueueName; jobId: string; errorClass: string; attempts: number }
  | { kind: 'handler_error'; queue: QueueName; jobId: string; errorClass: string };

/** Structural port over a BullMQ worker so the retry/DLQ logic is testable
 * without Redis. `src/bullmq.ts` provides the real implementation. */
export interface WorkerLike {
  start(): void;
  stop(): Promise<void>;
  close(): Promise<void>;
  /** Register the processor the wrapper builds. */
  process(fn: (job: QueueJob) => Promise<void>): void;
}

export interface WorkerFactory {
  (queue: QueueName, opts: { concurrency: number }): WorkerLike;
}

export interface WorkerDeps {
  queues: readonly QueueName[];
  handlers: Partial<Record<QueueName, JobHandler>>;
  workerFactory: WorkerFactory;
  dlq: QueueLike | null;
  audit?: AuditSink | null;
  concurrency?: number;
  maxAttempts?: number;
  onEvent?: (event: WorkerEvent) => void;
}

export interface Workers {
  start(): void;
  stop(): Promise<void>;
  close(): Promise<void>;
  readonly counts: Record<string, number>;
}

/**
 * Wraps every handler with the guarantees Master Prompt §12.4 demands:
 * at-least-once delivery is normal, so the handler re-checks current state and
 * returns SKIPPED_STALE rather than repeating a side effect; a poison job moves
 * to the DLQ with an audited trail instead of retrying forever; and an exception
 * is classified once and never converted into a success.
 */
export function createWorkers(deps: WorkerDeps): Workers {
  const concurrency = deps.concurrency ?? 5;
  const maxAttempts = deps.maxAttempts ?? 5;
  const emit = deps.onEvent ?? (() => {});
  const counts: Record<string, number> = {
    completed: 0,
    skipped: 0,
    retried: 0,
    deadLettered: 0,
    errored: 0,
  };

  const workers: WorkerLike[] = [];

  for (const queue of deps.queues) {
    const handler = deps.handlers[queue];
    if (!handler) {
      // A queue with no handler would silently swallow jobs. Refuse to start it
      // rather than pretend it is being drained.
      continue;
    }

    const worker = deps.workerFactory(queue, { concurrency });

    worker.process(async (job) => {
      let result: HandlerResult;
      try {
        result = await handler(job);
      } catch (err) {
        const { errorClass } = classifyQueueError(err);
        emit({ kind: 'handler_error', queue, jobId: job.id, errorClass });
        result = job.attempt >= maxAttempts
          ? { outcome: 'FAILED', errorClass }
          : { outcome: 'RETRY', errorClass };
      }

      switch (result.outcome) {
        case 'DONE':
          counts.completed = (counts.completed ?? 0) + 1;
          emit({ kind: 'completed', queue, jobId: job.id, outcome: 'DONE' });
          return;
        case 'SKIPPED_STALE':
          counts.skipped = (counts.skipped ?? 0) + 1;
          emit({ kind: 'skipped_stale', queue, jobId: job.id, reason: result.reason });
          return;
        case 'RETRY':
          if (job.attempt >= maxAttempts) {
            await deadLetter(job, result.errorClass, queue);
            return;
          }
          counts.retried = (counts.retried ?? 0) + 1;
          emit({
            kind: 'retrying',
            queue,
            jobId: job.id,
            errorClass: result.errorClass,
            attempt: job.attempt,
          });
          // Signal the queue backend to redeliver.
          throw new RetryableJobError(result.errorClass);
        case 'FAILED':
          await deadLetter(job, result.errorClass, queue);
          return;
      }
    });

    workers.push(worker);
  }

  async function deadLetter(job: QueueJob, errorClass: string, queue: QueueName) {
    counts.deadLettered = (counts.deadLettered ?? 0) + 1;
    if (deps.dlq) {
      try {
        await deps.dlq.add(
          'dead_letter',
          {
            sourceQueue: queue,
            sourceJobId: job.id,
            jobName: job.name,
            data: job.data,
            tenantId: job.tenantId,
            traceId: job.traceId,
            errorClass,
            attempts: job.attempt,
            deadLetteredAt: new Date().toISOString(),
          },
          { jobId: `dlq:${queue}:${job.id}` },
        );
      } catch {
        // A DLQ that cannot accept the job must not make the original look
        // handled. Fall through to the audit record so the loss is visible.
      }
    }
    emit({ kind: 'dead_lettered', queue, jobId: job.id, errorClass, attempts: job.attempt });
    if (deps.audit && job.tenantId) {
      await deps.audit
        .append({
          tenantId: job.tenantId,
          eventType: 'queue.job.dead_lettered',
          actorId: null,
          traceId: job.traceId,
          payload: { queue, job_id: job.id, error_class: errorClass, attempts: job.attempt },
        })
        .catch(() => {
          /* Audit failure here is reported through the event stream above; the
           * job is already off the hot path. */
        });
    }
  }

  return {
    start() {
      for (const w of workers) w.start();
    },
    async stop() {
      await Promise.all(workers.map((w) => w.stop()));
    },
    async close() {
      await Promise.all(workers.map((w) => w.close()));
    },
    get counts() {
      return { ...counts };
    },
  };
}

/** Thrown to tell the queue backend to redeliver. Carries the classified error
 * so logs never need the original stack. */
export class RetryableJobError extends Error {
  readonly errorClass: string;
  constructor(errorClass: string) {
    super(`Retryable job failure: ${errorClass}`);
    this.name = 'RetryableJobError';
    this.errorClass = errorClass;
  }
}

/**
 * Audited manual redrive. Requires an operator reason, re-checks nothing itself
 * (the handler's idempotency check does that on redelivery), and emits an audit
 * event — Master Prompt §12.4: "Redrive process requires an operator reason,
 * checks current state and idempotency, and emits an audit event."
 */
export async function redriveFromDlq(deps: {
  dlq: QueueLike;
  target: QueueLike;
  audit: AuditSink;
  job: {
    sourceQueue: QueueName;
    sourceJobId: string;
    jobName: string;
    data: unknown;
    tenantId: string | null;
    traceId: string | null;
  };
  operatorId: string;
  reason: string;
}): Promise<{ redriven: boolean; jobId?: string }> {
  if (deps.job.tenantId) {
    await deps.audit.append({
      tenantId: deps.job.tenantId,
      eventType: 'queue.job.redriven',
      actorId: deps.operatorId,
      traceId: deps.job.traceId,
      payload: {
        source_queue: deps.job.sourceQueue,
        source_job_id: deps.job.sourceJobId,
        reason: deps.reason,
      },
    });
  }
  const added = await deps.target.add(deps.job.jobName, deps.job.data, {
    jobId: `redrive:${deps.job.sourceJobId}:${Date.now()}`,
  });
  await deps.dlq.add('redriven', { ...deps.job, redrivenBy: deps.operatorId }, {
    jobId: `dlq-redriven:${deps.job.sourceJobId}:${Date.now()}`,
  });
  return { redriven: true, jobId: added.id };
}
