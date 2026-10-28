/**
 * A deadline for a queue command.
 *
 * The failure this exists for is not slow — it is *never*. A Redis command
 * issued against a dead server does not reject: the client keeps it in a
 * promise that settles when the server comes back, and the caller awaits it
 * for as long as the outage lasts. A dispatcher that awaits such a command
 * never finishes a batch, so its in-flight guard never clears and it stops
 * dispatching — permanently, and without an error anywhere. Every alert that
 * would have noticed the stall is waiting on the same promise.
 *
 * A deadline turns "never" into "failed", which the retry policy already
 * knows how to handle.
 */
import { QueueTimeoutError } from './types.js';

/**
 * Race `work` against a timer.
 *
 * The timer is unref'd so a pending deadline never holds the process open on
 * its own — the dispatcher's poll interval is unref'd for the same reason.
 */
export async function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new QueueTimeoutError(label, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  try {
    // `Promise.race` attaches a handler to both promises, so a rejection that
    // arrives after the deadline won is still observed — no unhandled rejection
    // escapes a command that was abandoned.
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
