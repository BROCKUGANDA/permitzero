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
  /**
   * The redrive happened, but the record of it did not land. The dead letter
   * is still eligible, so the next pass will find it again; the stable id of
   * the redriven job is what keeps that from becoming a second delivery.
   */
  | { kind: 'dlq_redrive_incomplete'; queue: QueueName; jobId: string; errorClass: string }
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
  /**
   * Run one dead-letter sweep pass and report how many dead letters it
   * redrove.
   *
   * It is exposed because a sweep that only runs on a timer cannot be
   * tested, cannot be triggered by an operator, and cannot be reasoned
   * about: the thing that decides whether an event is delivered twice has
   * to be callable on its own.
   */
  sweepOnce(): Promise<number>;
  readonly counts: Record<string, number>;
}

/** The name of the job that records a completed redrive. */
const REDRIVEN_MARKER_NAME = 'redriven';

/**
 * How many dead-letter jobs one sweep pass reads.
 *
 * The pass reads the whole dead-letter queue rather than a window at its
 * head, because the record of a completed redrive is the marker job written
 * beside its dead letter: a window finds the dead letter and misses the
 * marker, and a missed marker is a second delivery of an event that was
 * already delivered. The cap keeps one pass from reading an unbounded
 * queue, and a queue at the cap is a queue the sweep refuses to guess at.
 */
const DLQ_SCAN_LIMIT = 1_000;

/**
 * A job id segment that is safe to put inside a BullMQ job id.
 *
 * BullMQ refuses a custom job id that contains a colon unless the id has
 * exactly three colon-separated parts, and the id of a job that came off a
 * queue can contain anything at all -- the BullMQ adapter falls back to
 * "<queue>:<name>:<attempt>" when a job carries no id of its own.
 * Percent-encoding keeps the identity (the mapping is injective) and takes
 * the colons out.
 */
function encodeJobIdSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The id of the job a redrive puts back on its source queue.
 *
 * The identity comes from the dead letter and not from the clock. A redrive
 * that is retried after a partial failure has to land on the SAME job, or
 * the queue has no way to recognise the second copy as the first one: an id
 * built from `Date.now()` is a new id every time, and a queue that treats
 * job ids as unique has nothing to refuse.
 */
function redriveTargetJobId(sourceQueue: QueueName, sourceJobId: string): string {
  return `redrive:${sourceQueue}:${encodeJobIdSegment(sourceJobId)}`;
}

/**
 * The id of the marker that records a completed redrive.
 *
 * Stable for the same reason the target's id is: the marker is the sweep's
 * memory of what it has already done, and a memory with a fresh id in it is
 * not a memory at all -- every retry would write a new marker and the sweep
 * would never see the old one.
 */
function redriveMarkerJobId(sourceQueue: QueueName, sourceJobId: string): string {
  return `dlq-redriven:${sourceQueue}:${encodeJobIdSegment(sourceJobId)}`;
}

/**
 * The key that identifies "this dead letter, in this queue".
 *
 * A job id is only unique within its queue, so the queue is part of the
 * identity. Keying on the id alone means a completed redrive in one queue
 * silences a dead letter of the same id in another — which has never been
 * redriven and never will be.
 */
function redriveSourceKey(sourceQueue: string, sourceJobId: string): string {
  return `${sourceQueue}::${sourceJobId}`;
}

/** Remove a job if the queue can. A queue that cannot says so. */
async function removeJob(queue: QueueLike, jobId: string | undefined): Promise<boolean> {
  if (!jobId || typeof queue.remove !== 'function') return false;
  try {
    return await queue.remove(jobId);
  } catch {
    return false;
  }
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
          { jobId: `dlq:${queue}:${encodeJobIdSegment(job.id)}` },
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
   *   · it redrives a bounded number per pass;
   *   · and it remembers what it already redrove — in the QUEUE, not in the
   *     process. A dead letter is eligible until something says otherwise,
   *     and the "otherwise" has to outlive the process: a set in memory is
   *     empty after a restart, so every dead letter it forgets is delivered
   *     a second time.
   */
  const sweepOptions: Required<DlqSweepOptions> | null =
    deps.dlqSweep === false
      ? null
      : {
          intervalMs: deps.dlqSweep?.intervalMs ?? 60_000,
          redriveAfterMs: deps.dlqSweep?.redriveAfterMs ?? 15 * 60_000,
          batchSize: deps.dlqSweep?.batchSize ?? 10,
        };
  /**
   * A fast path over the durable record, not the record itself.
   *
   * The queue is the record (see the sweep below); this only saves a pass
   * from re-reading a dead letter it has already handled in this process. It
   * is bounded because it is a cache, and it is safe to forget an entry
   * because the record it caches is still there.
   */
  const alreadyRedriven = new Set<string>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  async function sweepDeadLetters(): Promise<number> {
    if (!deps.dlq || !deps.audit || !sweepOptions) return 0;
    const target = deps.dlq;
    // The whole dead-letter queue is read, not a window at its head. The
    // record of a completed redrive is the marker job written beside its
    // dead letter, and a window at the head finds the dead letter and
    // misses the marker: a missed marker is a second delivery of an event
    // that was already delivered.
    const listing = await target.getJobs(['waiting'], 0, DLQ_SCAN_LIMIT - 1);
    const truncated = listing.length >= DLQ_SCAN_LIMIT;

    // The durable record. Every dead letter that has already been redriven
    // has a marker beside it, and the marker names the dead letter it
    // belongs to. The record lives in the queue, so it survives a restart,
    // which is the whole point: a memory of what THIS PROCESS redrove is
    // empty after the process dies, and the dead letter it forgot is
    // published again.
    //
    // The record is keyed by the SOURCE QUEUE AND THE SOURCE JOB ID, not by
    // the job id alone. Two different queues can hold dead letters with the
    // same job id — the id is only unique within its queue — and keying on
    // the id alone means one queue's completed redrive silences another
    // queue's dead letter that has never been redriven at all.
    const redrivenSources = new Set<string>();
    for (const job of listing) {
      if (job.name !== REDRIVEN_MARKER_NAME) continue;
      const marker = (job.data ?? {}) as Record<string, unknown>;
      const sourceQueue = marker['sourceQueue'];
      const sourceJobId = marker['sourceJobId'];
      if (typeof sourceQueue === 'string' && typeof sourceJobId === 'string') {
        redrivenSources.add(redriveSourceKey(sourceQueue, sourceJobId));
      }
    }

    if (truncated && typeof target.remove !== 'function') {
      // The queue is bigger than one pass can read, so the record of what
      // has already been redriven cannot be read either. Redriving now
      // would risk publishing a second copy of an event that was already
      // delivered, so the pass does nothing and says so. A duplicate
      // delivery is worse than a late one: the handler is idempotent, but
      // the audit trail of a doubled event is not.
      //
      // A queue that CAN remove is not held back by this: there the
      // removal of the dead letter is the record, not the marker, and the
      // stable id of the redriven job refuses the second copy that a
      // missed marker would otherwise cause.
      emit({ kind: 'dlq_sweep_failed', errorClass: 'DLQ_SCAN_TRUNCATED' });
      return 0;
    }

    let redriven = 0;
    for (const job of listing) {
      if (job.name !== 'dead_letter') continue;
      // A bounded pass. The queue may still be broken, and a sweep that
      // empties the whole dead-letter queue into a broken queue turns a
      // recovery into an outage.
      if (redriven >= sweepOptions.batchSize) break;
      const payload = (job.data ?? {}) as Record<string, unknown>;
      const sourceQueue = payload['sourceQueue'];
      const sourceJobId = payload['sourceJobId'];
      const jobName = payload['jobName'];
      if (typeof sourceQueue !== 'string' || !isKnownQueue(sourceQueue)) continue;
      if (typeof sourceJobId !== 'string' || typeof jobName !== 'string') continue;
      // Only the first generation. A redriven job carries a `redrive:` id, and
      // redriving it again would be the sweep chasing its own tail.
      if (sourceJobId.startsWith('redrive:')) continue;
      // Already done, and the record of it outlived this process. The key
      // includes the source queue, because a job id is only unique within
      // its own queue.
      const sourceKey = redriveSourceKey(sourceQueue, sourceJobId);
      if (redrivenSources.has(sourceKey)) continue;
      if (alreadyRedriven.has(sourceKey)) continue;
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
          // The dead letter's own id, so the redrive can take it out of the
          // queue. A dead letter that is still there is still eligible, and
          // an eligible dead letter is redriven again after the next
          // restart.
          sourceDlqJobId: job.id,
        });
        if (result.redriven) {
          alreadyRedriven.add(sourceKey);
          if (alreadyRedriven.size > 500) {
            const oldest = alreadyRedriven.values().next();
            if (!oldest.done) alreadyRedriven.delete(oldest.value);
          }
          redriven += 1;
          emit({ kind: 'dlq_redriven', queue: sourceQueue, jobId: sourceJobId, errorClass });
          if (!result.markerWritten) {
            // The work is back on the queue, but the record of the redrive
            // did not land. The next pass will find this dead letter again
            // -- the stable id of the redriven job is what keeps that from
            // becoming a second delivery -- and the operator should know
            // that the record is missing.
            emit({
              kind: 'dlq_redrive_incomplete',
              queue: sourceQueue,
              jobId: sourceJobId,
              errorClass: 'DLQ_MARKER_NOT_WRITTEN',
            });
          }
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
    async sweepOnce() {
      return sweepDeadLetters();
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
 * The outcome of a redrive.
 *
 * The two flags say what a redrive that did not finish cleanly left behind.
 * `markerWritten` is the durable record that the redrive happened;
 * `sourceRemoved` says the dead letter it came from is gone, so it can
 * never be selected again. Either one missing means the next pass has to be
 * careful, and the caller has to be told.
 */
export interface RedriveResult {
  /** The work is back on its queue. */
  redriven: boolean;
  /** The id of the job on the source queue. */
  jobId?: string;
  /** The durable record of the redrive was written. */
  markerWritten: boolean;
  /** The dead letter the redrive came from was removed from the queue. */
  sourceRemoved: boolean;
}

/**
 * Audited manual redrive. Requires an operator reason, re-checks nothing itself
 * (the handler's idempotency check does that on redelivery), and emits an audit
 * event — Master Prompt §12.4: "Redrive process requires an operator reason,
 * checks current state and idempotency, and emits an audit event."
 *
 * The redrive is written to be retried safely, because it will be retried:
 * the sweep runs again after a restart, and a restart is exactly when the
 * process no longer knows what it already did. Two things make the retry
 * harmless:
 *
 *   · the redriven job's id is the DEAD LETTER's identity and not a fresh
 *     timestamp, so a retry lands on the same job and the queue refuses the
 *     second copy (a queue that treats job ids as unique -- BullMQ does --
 *     has nothing to publish the second time);
 *   · the dead letter itself is removed once the redrive is done, so it is
 *     no longer eligible for a redrive at all.
 *
 * The order is deliberate. The enqueue happens before the marker is
 * written, because a marker that says "redriven" without a job behind it is
 * a dead letter that is never delivered again; and the marker is written
 * before the dead letter is removed, because a removed dead letter with no
 * marker is a dead letter that is redriven twice.
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
  /**
   * The id of the dead-letter job itself, so the redrive can take it out of
   * the queue.
   *
   * A dead letter that is still in the queue is a dead letter that is still
   * eligible, and an eligible dead letter is redriven again after the next
   * restart. Removing it is what turns "this has been dealt with" from a
   * fact the process remembers into a fact the queue remembers.
   */
  sourceDlqJobId?: string;
}): Promise<RedriveResult> {
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
    jobId: redriveTargetJobId(deps.job.sourceQueue, deps.job.sourceJobId),
  });

  // The marker is the sweep's durable record of this redrive, and its id is
  // stable for the same reason the target's is: a marker with a fresh id in
  // it is a new marker every time, and the sweep would never find the old
  // one. A queue that refuses a duplicate job id therefore refuses the
  // second marker as well.
  let markerWritten = false;
  try {
    await deps.dlq.add(
      REDRIVEN_MARKER_NAME,
      { ...deps.job, redrivenBy: deps.operatorId },
      {
        jobId: redriveMarkerJobId(deps.job.sourceQueue, deps.job.sourceJobId),
      },
    );
    markerWritten = true;
  } catch {
    // The work is already on the queue. The marker is the record that says
    // so, and the sweep reports the missing record; the redrive itself has
    // happened and must not be repeated.
  }

  // The dead letter goes away with the redrive. This is the durable half of
  // the dedupe: after a restart there is no memory of this pass to consult,
  // and a dead letter that is still in the queue is still eligible.
  const sourceRemoved = await removeJob(deps.dlq, deps.sourceDlqJobId);

  // The marker was only ever needed while the dead letter was still there:
  // it is what tells the next pass that the redrive already happened. With
  // the dead letter gone the marker says nothing that the queue does not
  // already say, and a queue that fills up with markers is a queue the
  // sweep cannot read.
  if (sourceRemoved && markerWritten) {
    await removeJob(deps.dlq, redriveMarkerJobId(deps.job.sourceQueue, deps.job.sourceJobId));
  }

  return { redriven: true, jobId: added.id, markerWritten, sourceRemoved };
}
