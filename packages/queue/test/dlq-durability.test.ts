/**
 * The dead-letter sweep's durability.
 *
 * The sweep is the only thing that delivers a poison job again, so the
 * question that matters is not "does it redrive" but "does it redrive
 * ONCE". Two failures make it redrive twice, and both of them are about
 * state that used to live in the process:
 *
 *   · the sweep remembered what it had already redriven in a set, and a set
 *     is empty after a restart -- so a worker that came back redrove every
 *     dead letter it had already handled, and every one of those was a
 *     second delivery of an event that had been delivered;
 *   · the redrive enqueued the job BEFORE it wrote the record of the
 *     redrive, and the target job's id carried a fresh timestamp -- so a
 *     failed record write left the sweep free to try again with a new id,
 *     which is a new job, which is a duplicate.
 *
 * The fake below is a queue, not a list: a job id is unique (BullMQ refuses
 * a second job with an id it already holds) and a job can be removed. Those
 * two properties are what the redrive leans on, so a fake that did not have
 * them would prove nothing.
 */
import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES, createWorkers, type QueueLike, type WorkerEvent } from '../src/index.js';

interface FakeJob {
  id: string;
  name: string;
  data: unknown;
}

interface FakeQueue extends QueueLike {
  jobs: FakeJob[];
  /** The job ids this queue was asked to add, in order. */
  added: Array<{ jobName: string; jobId: string | null }>;
  /** Job names whose `add` must fail, to model a broken write. */
  failAddFor: Set<string>;
  /** Whether the queue can remove jobs at all. */
  canRemove: boolean;
}

function makeQueue(name: string, opts: { canRemove?: boolean } = {}): FakeQueue {
  const canRemove = opts.canRemove ?? true;
  const jobs: FakeJob[] = [];
  const added: Array<{ jobName: string; jobId: string | null }> = [];
  const failAddFor = new Set<string>();
  const queue: FakeQueue = {
    name,
    jobs,
    added,
    failAddFor,
    canRemove,
    async add(jobName: string, data: unknown, addOpts?: Record<string, unknown>) {
      if (failAddFor.has(jobName)) throw new Error(`queue ${name}: cannot add ${jobName}`);
      const jobId =
        typeof addOpts?.['jobId'] === 'string' ? (addOpts['jobId'] as string) : `${name}:${jobs.length + 1}`;
      added.push({ jobName, jobId });
      // A queue that treats job ids as unique refuses the second copy of a
      // job it already holds. BullMQ does exactly this, and it is what
      // turns a retried enqueue into a no-op instead of a duplicate.
      const existing = jobs.find((job) => job.id === jobId);
      if (existing) return { id: existing.id };
      jobs.push({ id: jobId, name: jobName, data });
      return { id: jobId };
    },
    async getJobCounts() {
      return {};
    },
    async getJobs(_statuses, start = 0, end = -1) {
      const slice = end === -1 ? jobs.slice(start) : jobs.slice(start, end + 1);
      return slice.map((job) => ({ id: job.id, name: job.name, data: job.data }));
    },
    async close() {
      return undefined;
    },
    ...(canRemove
      ? {
          async remove(jobId: string) {
            const index = jobs.findIndex((job) => job.id === jobId);
            if (index === -1) return false;
            jobs.splice(index, 1);
            return true;
          },
        }
      : {}),
  };
  return queue;
}

function deadLetter(sourceJobId: string): FakeJob {
  return {
    id: `dlq:${QUEUE_NAMES.outbox}:${sourceJobId}`,
    name: 'dead_letter',
    data: {
      sourceQueue: QUEUE_NAMES.outbox,
      sourceJobId,
      jobName: 'action.decided',
      data: { action_id: 'act_1' },
      tenantId: 'ten_test',
      traceId: null,
      errorClass: 'CONNECTOR_TIMEOUT',
      attempts: 5,
      deadLetteredAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
  };
}

/** A worker wired to the two queues, with the sweep ready to run on demand. */
function makeWorkers(dlq: QueueLike, target: QueueLike, events: WorkerEvent[]) {
  return createWorkers({
    queues: [QUEUE_NAMES.outbox],
    handlers: { [QUEUE_NAMES.outbox]: async () => ({ outcome: 'DONE' }) },
    workerFactory: () => ({
      start: () => undefined,
      stop: async () => undefined,
      close: async () => undefined,
      process: () => undefined,
      queue: target,
    }),
    dlq,
    audit: { append: async () => undefined },
    dlqSweep: { intervalMs: 60_000, redriveAfterMs: 0, batchSize: 10 },
    onEvent: (event) => events.push(event),
  });
}

describe('the dead-letter sweep does not deliver an event twice', () => {
  it('does not redrive a dead letter again after the worker restarts', async () => {
    // A queue that cannot remove: the durable record is the marker the
    // redrive wrote into the dead-letter queue, and the sweep has to find it
    // there after the restart. A process-local set would not survive.
    const dlq = makeQueue(QUEUE_NAMES.deadLetter, { canRemove: false });
    const target = makeQueue(QUEUE_NAMES.outbox, { canRemove: false });
    dlq.jobs.push(deadLetter('job_1'));

    const first = makeWorkers(dlq, target, []);
    expect(await first.sweepOnce(), 'the dead letter was not redriven').toBe(1);
    expect(target.jobs.filter((job) => job.name === 'action.decided')).toHaveLength(1);
    // The record of the redrive is in the queue, not in the process.
    expect(dlq.jobs.some((job) => job.name === 'redriven')).toBe(true);

    // The worker restarts: a new process, with nothing in memory.
    const events: WorkerEvent[] = [];
    const second = makeWorkers(dlq, target, events);
    expect(await second.sweepOnce(), 'the dead letter was redriven a second time').toBe(0);
    expect(target.jobs.filter((job) => job.name === 'action.decided')).toHaveLength(1);
  });

  it('removes the dead letter once its redrive is done', async () => {
    const dlq = makeQueue(QUEUE_NAMES.deadLetter);
    const target = makeQueue(QUEUE_NAMES.outbox);
    dlq.jobs.push(deadLetter('job_1'));

    const workers = makeWorkers(dlq, target, []);
    expect(await workers.sweepOnce()).toBe(1);

    // The dead letter is gone, so it is not eligible any more -- and the
    // marker went with it, because a queue full of markers is a queue the
    // sweep cannot read.
    expect(dlq.jobs.filter((job) => job.name === 'dead_letter')).toHaveLength(0);
    expect(dlq.jobs.filter((job) => job.name === 'redriven')).toHaveLength(0);

    // A restart finds nothing to do.
    const events: WorkerEvent[] = [];
    const restarted = makeWorkers(dlq, target, events);
    expect(await restarted.sweepOnce()).toBe(0);
    expect(target.jobs.filter((job) => job.name === 'action.decided')).toHaveLength(1);
  });

  it('does not publish a second copy when the record of the redrive cannot be written', async () => {
    // The marker write fails: the dead letter stays, and the sweep will see
    // it again. The redriven job's id is the dead letter's identity, so the
    // second attempt lands on the job that is already there and the queue
    // refuses the duplicate.
    const dlq = makeQueue(QUEUE_NAMES.deadLetter, { canRemove: false });
    const target = makeQueue(QUEUE_NAMES.outbox, { canRemove: false });
    dlq.jobs.push(deadLetter('job_1'));
    dlq.failAddFor.add('redriven');

    const first = makeWorkers(dlq, target, []);
    expect(await first.sweepOnce()).toBe(1);
    expect(target.jobs.filter((job) => job.name === 'action.decided')).toHaveLength(1);
    expect(
      dlq.jobs.some((job) => job.name === 'redriven'),
      'the marker should not be there',
    ).toBe(false);

    // The worker restarts. Nothing in memory says the redrive happened, so
    // the sweep tries again -- and must not publish the event twice.
    const events: WorkerEvent[] = [];
    const second = makeWorkers(dlq, target, events);
    await second.sweepOnce();

    expect(target.jobs.filter((job) => job.name === 'action.decided')).toHaveLength(1);
    // Both attempts used the same id: that is what the queue refuses.
    const targetIds = target.added.filter((entry) => entry.jobName === 'action.decided').map((entry) => entry.jobId);
    expect(targetIds).toHaveLength(2);
    expect(new Set(targetIds).size, 'the retry used a fresh job id').toBe(1);
    // And the operator is told that the record of the redrive is missing.
    expect(events.some((event) => event.kind === 'dlq_redrive_incomplete')).toBe(true);
  });
});
