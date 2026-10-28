import { classifyQueueError, isKnownQueue, type QueueLike } from './types.js';
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
  | { kind: 'handler_error'; queue: QueueName; jobId: string; errorClass: string }
  | { kind: 'dlq_redriven'; queue: QueueName; jobId: string; errorClass: string }
  | { kind: 'dlq_sweep_failed'; errorClass: string };

/**
 * The automatic dead-letter sweep.
 *
 * `false` switches it off. The defaults are deliberately reluctant: a dead
 * letter is only retried once it has been waiting long enough for whatever
 * broke it to be fixed, and only a bounded number per pass, so the sweep can
 * never become a busy loop against a queue that is still broken.
 */
export interface DlqSweepOptions {
  /** How often the sweep runs. */
  intervalMs?: number;
  /** How long a dead letter must have been waiting before it is retried. */
  redriveAfterMs?: number;
  /** How many dead letters one pass may redrive. */
  batchSize?: number;
}

/** Structural port over a BullMQ worker so the retry/DLQ logic is testable
 * without Redis. `src/bullmq.ts` provides the real implementation. */
export interface WorkerLike {
  start(): void;
  stop(): Promise<void>;
  close(): Promise<void>;
  /** Register the processor the wrapper builds. */
  process(fn: (job: QueueJob) => Promise<void>): void;
  /**
   * The producer handle for the queue this worker consumes.
   *
   * A dead letter has to go back to the queue it came from, and the worker is
   * the only thing that knows which queue that is. The handle is a producer
   * connection, not the blocking worker connection: enqueueing must fail fast
   * when Redis is down instead of waiting on a promise that never settles.
   */
  queue?: QueueLike;
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
  /**
   * The automatic dead-letter sweep. `false` switches it off; the default is
   * on, because a dead letter nobody retries is an event nobody will ever
   * deliver — the alert told the operator to redrive it through a surface that
   * did not exist.
   */
  dlqSweep?: DlqSweepOptions | false;
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
  /** Where a dead letter goes back to: the queue it was taken from. */
  const redriveTargets = new Map<QueueName, QueueLike>();

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
        result = job.attempt >= maxAttempts ? { outcome: 'FAILED', errorClass } : { outcome: 'RETRY', errorClass };
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
    if (worker.queue) redriveTargets.set(queue, worker.queue);
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

  /**
   * The dead-letter sweep.
   *
   * A dead letter used to be a dead end: the alert said "redrive it through the
   * operator surface" and no such surface existed, so the event was simply
   * never delivered again. The sweep redrives automatically, but only what is
   * plausibly fixed:
   *
   *   · it waits `redriveAfterMs` before touching anything, so a queue that is
   *     still broken is not hammered;
   *   · it redrives only first-generation dead letters — a redriven job that
   *     fails again stays dead, because a sweep that requeues its own output
   *     forever is a loop wearing a recovery hat;
   *   · it redrives a bounded number per pass, and remembers what it already
   *     redriven so a second pass does not publish the same event twice.
   */
  const sweepOptions: Required<DlqSweepOptions> | null =
    deps.dlqSweep === false
      ? null
      : {
          intervalMs: deps.dlqSweep?.intervalMs ?? 60_000,
          redriveAfterMs: deps.dlqSweep?.redriveAfterMs ?? 15 * 60_000,
          batchSize: deps.dlqSweep?.batchSize ?? 10,
        };
  const alreadyRedriven = new Set<string>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  async function sweepDeadLetters(): Promise<number> {
    if (!deps.dlq || !deps.audit || !sweepOptions) return 0;
    const target = deps.dlq;
    // Look at more than the pass may redrive: the window is also full of the
    // jobs this sweep has already handled, and of the `redriven` markers the
    // redrive itself leaves behind.
    const jobs = await target.getJobs(['waiting'], 0, Math.max(0, sweepOptions.batchSize * 10 - 1));
    let redriven = 0;
    for (const job of jobs) {
      if (job.name !== 'dead_letter') continue;
      const payload = (job.data ?? {}) as Record<string, unknown>;
      const sourceQueue = payload['sourceQueue'];
      const sourceJobId = payload['sourceJobId'];
      const jobName = payload['jobName'];
      if (typeof sourceQueue !== 'string' || !isKnownQueue(sourceQueue)) continue;
      if (typeof sourceJobId !== 'string' || typeof jobName !== 'string') continue;
      // Only the first generation. A redriven job carries a `redrive:` id, and
      // redriving it again would be the sweep chasing its own tail.
      if (sourceJobId.startsWith('redrive:')) continue;
      if (alreadyRedriven.has(sourceJobId)) continue;
      const deadLetteredAt = Date.parse(typeof payload['deadLetteredAt'] === 'string' ? payload['deadLetteredAt'] : '');
      if (!Number.isFinite(deadLetteredAt)) continue;
      if (Date.now() - deadLetteredAt < sweepOptions.redriveAfterMs) continue;
      const queue = redriveTargets.get(sourceQueue);
      if (!queue) continue;
      const errorClass = typeof payload['errorClass'] === 'string' ? payload['errorClass'] : 'UNKNOWN';
      try {
        const result = await redriveFromDlq({
          dlq: target,
          target: queue,
          audit: deps.audit,
          job: {
            sourceQueue,
            sourceJobId,
            jobName,
            data: payload['data'] ?? null,
            tenantId: typeof payload['tenantId'] === 'string' ? payload['tenantId'] : null,
            traceId: typeof payload['traceId'] === 'string' ? payload['traceId'] : null,
          },
          operatorId: 'system:dlq-sweep',
          reason: 'automatic dead-letter sweep: the downstream cause has had time to be fixed',
        });
        if (result.redriven) {
          alreadyRedriven.add(sourceJobId);
          // The set is a memory of what this process already redrove, so it
          // is bounded: the oldest entries are the ones whose dead letter has
          // been sitting in the queue longest, and the queue itself is the
          // durable record.
          if (alreadyRedriven.size > 500) {
            const oldest = alreadyRedriven.values().next();
            if (!oldest.done) alreadyRedriven.delete(oldest.value);
          }
          redriven += 1;
          emit({ kind: 'dlq_redriven', queue: sourceQueue, jobId: sourceJobId, errorClass });
        }
      } catch (err) {
        // The sweep is best-effort: a dead letter that cannot be redriven now
        // is still in the dead-letter queue, and the next pass will try again.
        const { errorClass: failureClass } = classifyQueueError(err);
        emit({ kind: 'dlq_redriven', queue: sourceQueue, jobId: sourceJobId, errorClass: failureClass });
      }
    }
    return redriven;
  }

  return {
    start() {
      for (const w of workers) w.start();
      if (sweepTimer || !sweepOptions || !deps.dlq) return;
      sweepTimer = setInterval(() => {
        void sweepDeadLetters().catch((err: unknown) => {
          // A sweep that cannot run is still a fact worth reporting: the dead
          // letters it would have redriven are still dead.
          const { errorClass } = classifyQueueError(err);
          emit({ kind: 'dlq_sweep_failed', errorClass });
        });
      }, sweepOptions.intervalMs);
      // The sweep is housekeeping; it must not keep the process alive.
      sweepTimer.unref?.();
    },
    async stop() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      await Promise.all(workers.map((w) => w.stop()));
    },
    async close() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
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
  await deps.dlq.add(
    'redriven',
    { ...deps.job, redrivenBy: deps.operatorId },
    {
      jobId: `dlq-redriven:${deps.job.sourceJobId}:${Date.now()}`,
    },
  );
  return { redriven: true, jobId: added.id };
}
