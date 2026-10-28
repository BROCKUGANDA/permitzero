import { OutboxStatus } from '@permitzero/domain';
import { queuePriority, type OutboxRow, type OutboxStore, type QueueName } from './names.js';
import { classifyQueueError, outboxJobPayload, type QueueFactory } from './types.js';
import { withDeadline } from './deadline.js';

export interface OutboxDispatcherDeps {
  store: OutboxStore;
  queues: QueueFactory;
  /** Milliseconds between claim batches. */
  pollIntervalMs?: number;
  batchSize?: number;
  /**
   * BullMQ delivery attempts per job. Must match the consumers'
   * `maxAttempts`: with fewer, the queue drops jobs the wrapper would have
   * retried and the DLQ path never runs.
   */
  jobAttempts?: number;
  /** Exponential backoff base for a failed publish. */
  retryBaseMs?: number;
  retryCapMs?: number;
  maxAttempts?: number;
  /**
   * How long one publish may take before it is abandoned. A queue command
   * against a dead backend does not reject — it waits — so without a deadline
   * the first outage stops the dispatcher for good.
   */
  publishTimeoutMs?: number;
  onEvent?: (event: DispatcherEvent) => void;
  now?: () => Date;
  random?: () => number;
}

export type DispatcherEvent =
  | { kind: 'published'; outboxId: string; queue: QueueName }
  | {
      kind: 'publish_failed';
      /** The row the failure belongs to, or null when it belongs to none. */
      outboxId: string | null;
      errorClass: string;
      attempt: number;
      retryable: boolean;
    }
  | { kind: 'dead'; outboxId: string; errorClass: string }
  | { kind: 'claim_failed'; errorClass: string }
  | { kind: 'queue_unavailable'; errorClass: string }
  | { kind: 'tick'; claimed: number };

export interface OutboxDispatcher {
  start(): void;
  stop(): Promise<void>;
  /** Run one claim-and-publish pass. Exposed for tests and for a manual nudge
   * from the operator UI; `start()` merely calls this on an interval. */
  drainOnce(): Promise<{ claimed: number; published: number; failed: number; dead: number }>;
  readonly running: boolean;
}

/**
 * Where dispatcher events go when the caller supplies no sink.
 *
 * A dispatcher built without an `onEvent` used to discard every event. The
 * worker's dispatcher logs them; the API's — the process that serves requests,
 * and the one an operator looks at first — did not, so in that process every
 * delivery failure was invisible while the process itself looked healthy.
 *
 * Successes stay quiet. `published` fires once per row and `tick` once per
 * poll; a log line for each of those is how a real failure disappears into
 * the noise.
 */
function defaultEventSink(event: DispatcherEvent): void {
  switch (event.kind) {
    case 'published':
    case 'tick':
      return;
    case 'dead':
      console.error(`[queue:dispatch] ${JSON.stringify(event)}`);
      return;
    default:
      console.warn(`[queue:dispatch] ${JSON.stringify(event)}`);
  }
}

/**
 * Publishes committed outbox rows to the queue.
 *
 * The row is written in the SAME database transaction as the state change it
 * describes (that is the caller's job — see `withTransaction` in @permitzero/db).
 * This dispatcher only moves an already-durable intent onto the queue, and marks
 * it PUBLISHED solely after the queue acknowledges. A Redis outage therefore
 * leaves rows PENDING and reports degraded; committed intent is never lost and
 * no unenforceable permit is issued as a result.
 */
export function createOutboxDispatcher(deps: OutboxDispatcherDeps): OutboxDispatcher {
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  const batchSize = deps.batchSize ?? 50;
  const jobAttempts = deps.jobAttempts ?? 5;
  const retryBaseMs = deps.retryBaseMs ?? 250;
  const retryCapMs = deps.retryCapMs ?? 8_000;
  const defaultMaxAttempts = deps.maxAttempts ?? 8;
  const publishTimeoutMs = deps.publishTimeoutMs ?? 5_000;
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const emit = deps.onEvent ?? defaultEventSink;

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  /**
   * Write the outcome of a failed publish, and survive the write failing.
   *
   * The store call is the last thing in this path that can still throw: the
   * freeze trigger refuses to update a PUBLISHED row, and a database that is
   * down refuses everything. Neither may abort the batch — the rows already
   * claimed would sit on their lease for a minute, and the error would
   * disappear into the loop's catch, which is exactly what it used to do.
   *
   * Returns whether the row was actually written. When it was not, the
   * failure is reported as `publish_failed` and the row is left alone.
   */
  async function record(
    row: OutboxRow,
    errorClass: string,
    attempt: number,
    retryable: boolean,
    write: () => Promise<boolean>,
  ): Promise<boolean> {
    try {
      const written = await write();
      if (written) return true;
      // The row is no longer ours to move: a peer published it while this
      // dispatcher held the claim. The same race `markPublished` reports, and
      // it is not an error worth retrying — the event is already delivered.
      emit({
        kind: 'publish_failed',
        outboxId: row.id,
        errorClass: 'OUTBOX_ALREADY_CLAIMED',
        attempt,
        retryable: false,
      });
      return false;
    } catch (err) {
      const classified = classifyQueueError(err);
      emit({
        kind: 'publish_failed',
        outboxId: row.id,
        errorClass: classified.errorClass,
        attempt,
        retryable: classified.retryable,
      });
      return false;
    }
  }

  async function publishRow(row: OutboxRow): Promise<'published' | 'failed' | 'dead'> {
    const maxAttempts = row.maxAttempts > 0 ? row.maxAttempts : defaultMaxAttempts;
    try {
      const queue = deps.queues(row.queueName);
      await withDeadline(
        queue.add(row.eventType, outboxJobPayload(row), {
          priority: queuePriority(row.queueName),
          // Deduplicate on the queue side too: the DB unique id is the real guard,
          // this only stops a double-claim from producing two visible jobs.
          jobId: `outbox:${row.id}`,
          attempts: jobAttempts,
          removeOnComplete: true,
          removeOnFail: false,
        }),
        publishTimeoutMs,
        `queue.add(${row.queueName})`,
      );
      const marked = await deps.store.markPublished(row.id, row.tenantId);
      if (!marked) {
        // Another dispatcher already moved it on. Not an error, not a duplicate
        // publish we can undo — report it so the operator can see the race.
        emit({
          kind: 'publish_failed',
          outboxId: row.id,
          errorClass: 'OUTBOX_ALREADY_CLAIMED',
          attempt: row.attemptCount + 1,
          retryable: false,
        });
        return 'failed';
      }
      emit({ kind: 'published', outboxId: row.id, queue: row.queueName });
      return 'published';
    } catch (err) {
      const { retryable, errorClass } = classifyQueueError(err);
      const attempt = row.attemptCount + 1;
      if (!retryable || attempt >= maxAttempts) {
        const parked = await record(row, errorClass, attempt, retryable, () =>
          deps.store.markDead(row.id, errorClass, row.tenantId),
        );
        if (parked) emit({ kind: 'dead', outboxId: row.id, errorClass });
        return 'dead';
      }
      // Full jitter, matching the retry policy used for provider calls.
      const cap = Math.min(retryCapMs, retryBaseMs * 2 ** attempt);
      const delay = Math.floor(random() * cap);
      const next = new Date(now().getTime() + delay);
      const written = await record(row, errorClass, attempt, retryable, () =>
        deps.store.markFailed(row.id, errorClass, next, row.tenantId),
      );
      if (written) emit({ kind: 'publish_failed', outboxId: row.id, errorClass, attempt, retryable });
      return 'failed';
    }
  }

  async function drainOnce() {
    // Do not claim what cannot be published. A claimed row that cannot be
    // enqueued spends one of its attempts per poll, so a queue outage that
    // outlasts `maxAttempts` polls would park every committed event as DEAD —
    // the outage would destroy the backlog it was supposed to pause.
    if (deps.queues.available && !deps.queues.available()) {
      emit({ kind: 'queue_unavailable', errorClass: 'QUEUE_UNAVAILABLE' });
      return { claimed: 0, published: 0, failed: 0, dead: 0 };
    }
    let rows: OutboxRow[];
    try {
      rows = await deps.store.claimPending(batchSize, now());
    } catch (err) {
      const { errorClass } = classifyQueueError(err);
      emit({ kind: 'claim_failed', errorClass });
      throw err;
    }
    let published = 0;
    let failed = 0;
    let dead = 0;
    for (const row of rows) {
      const outcome = await publishRow(row);
      if (outcome === 'published') published += 1;
      else if (outcome === 'dead') dead += 1;
      else failed += 1;
    }
    emit({ kind: 'tick', claimed: rows.length });
    return { claimed: rows.length, published, failed, dead };
  }

  async function loop() {
    // Serialize passes so a slow Redis cannot stack up concurrent claims.
    if (inFlight) return;
    inFlight = (async () => {
      try {
        const result = await drainOnce();
        // Keep draining while the batch was full — there is probably more.
        if (!stopped && result.claimed >= batchSize) {
          setImmediate(() => void loop());
        }
      } catch (err) {
        // Reported, not swallowed. This catch used to be empty, which meant a
        // failure that escaped `drainOnce` — a row the database refused to
        // update, for instance — left no event, no log and no metric anywhere.
        // The claim failure above already reported itself; this is the
        // backstop for everything that did not.
        const { retryable, errorClass } = classifyQueueError(err);
        emit({ kind: 'publish_failed', outboxId: null, errorClass, attempt: 0, retryable });
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  }

  return {
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => void loop(), pollIntervalMs);
      // Do not keep the process alive solely to poll.
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
    },
    drainOnce,
    get running() {
      return timer !== null;
    },
  };
}

export { OutboxStatus };
