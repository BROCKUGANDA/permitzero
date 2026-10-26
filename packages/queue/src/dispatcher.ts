import { OutboxStatus } from '@permitzero/domain';
import { queuePriority, type OutboxRow, type OutboxStore, type QueueName } from './names.js';
import { classifyQueueError, outboxJobPayload, type QueueFactory } from './types.js';

export interface OutboxDispatcherDeps {
  store: OutboxStore;
  queues: QueueFactory;
  /** Milliseconds between claim batches. */
  pollIntervalMs?: number;
  batchSize?: number;
  /** Exponential backoff base for a failed publish. */
  retryBaseMs?: number;
  retryCapMs?: number;
  maxAttempts?: number;
  onEvent?: (event: DispatcherEvent) => void;
  now?: () => Date;
  random?: () => number;
}

export type DispatcherEvent =
  | { kind: 'published'; outboxId: string; queue: QueueName }
  | { kind: 'publish_failed'; outboxId: string; errorClass: string; attempt: number; retryable: boolean }
  | { kind: 'dead'; outboxId: string; errorClass: string }
  | { kind: 'claim_failed'; errorClass: string }
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
  const retryBaseMs = deps.retryBaseMs ?? 250;
  const retryCapMs = deps.retryCapMs ?? 8_000;
  const defaultMaxAttempts = deps.maxAttempts ?? 8;
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const emit = deps.onEvent ?? (() => {});

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  async function publishRow(row: OutboxRow): Promise<'published' | 'failed' | 'dead'> {
    const maxAttempts = row.maxAttempts > 0 ? row.maxAttempts : defaultMaxAttempts;
    try {
      const queue = deps.queues(row.queueName);
      await queue.add(row.eventType, outboxJobPayload(row), {
        priority: queuePriority(row.queueName),
        // Deduplicate on the queue side too: the DB unique id is the real guard,
        // this only stops a double-claim from producing two visible jobs.
        jobId: `outbox:${row.id}`,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false,
      });
      const marked = await deps.store.markPublished(row.id);
      if (!marked) {
        // Another dispatcher already moved it on. Not an error, not a duplicate
        // publish we can undo — report it so the operator can see the race.
        emit({ kind: 'publish_failed', outboxId: row.id, errorClass: 'OUTBOX_ALREADY_CLAIMED', attempt: row.attemptCount + 1, retryable: false });
        return 'failed';
      }
      emit({ kind: 'published', outboxId: row.id, queue: row.queueName });
      return 'published';
    } catch (err) {
      const { retryable, errorClass } = classifyQueueError(err);
      const attempt = row.attemptCount + 1;
      if (!retryable || attempt >= maxAttempts) {
        await deps.store.markDead(row.id, errorClass);
        emit({ kind: 'dead', outboxId: row.id, errorClass });
        return 'dead';
      }
      // Full jitter, matching the retry policy used for provider calls.
      const cap = Math.min(retryCapMs, retryBaseMs * 2 ** attempt);
      const delay = Math.floor(random() * cap);
      const next = new Date(now().getTime() + delay);
      await deps.store.markFailed(row.id, errorClass, next);
      emit({ kind: 'publish_failed', outboxId: row.id, errorClass, attempt, retryable });
      return 'failed';
    }
  }

  async function drainOnce() {
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
      } catch {
        // Already reported through `claim_failed`. Never let the interval die.
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
