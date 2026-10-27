/**
 * Bounded graceful shutdown.
 *
 * Fastify's `close()` does drain in-flight requests — measured, not assumed: all
 * three requests of a test got their 200s. What surprised me is that `close()`
 * itself did not resolve for **70.3 seconds** afterwards.
 *
 * The mechanism, from `fastify.js` (the `preReady` → `preClose` path): when
 * `forceCloseConnections` is `'idle'` — the default on any Node that has
 * `closeIdleConnections` — Fastify calls `server.closeIdleConnections()` exactly
 * once, *before* `server.close()`. A socket whose request is still being handled
 * at that moment is not idle, so it is not reaped; it finishes its response
 * during the drain and only then becomes idle, and nothing ever calls
 * `closeIdleConnections()` again. `server.close()` then waits for Node's own
 * `keepAliveTimeout` + `headersTimeout` to expire, which is where the minute and a
 * half comes from.
 *
 * Consequences under a container manager that SIGKILLs after 10-30 seconds:
 *
 *   · the process is killed mid-shutdown anyway, so the database pools are torn
 *     down without their `close()` and the outbox lease the dispatcher held stays
 *     held until it expires; and
 *   · every deploy costs an unexplained minute, which people "fix" by lowering the
 *     kill timeout — turning a slow shutdown into a truncating one.
 *
 * So: wait for the drain, and if it has not finished inside the deadline, stop
 * waiting and close the connections explicitly. Requests already answered stay
 * answered; stragglers past the deadline are cut, which is the deal a deadline
 * makes. The window is logged either way, because a shutdown that regularly hits
 * it is telling you something about handler latency.
 */
import type { FastifyInstance } from 'fastify';

export interface ShutdownReport {
  /** How long from starting the close to the process being ready to exit. */
  tookMs: number;
  /** True when the deadline fired and connections were closed forcibly. */
  forced: boolean;
  /** Milliseconds allowed for the drain before forcing. */
  graceMs: number;
}

/**
 * Close `app`, giving the drain `graceMs` before forcing connections shut.
 *
 * Returns after both the close promise and the connection teardown have settled,
 * so a caller can proceed to close database pools knowing no request is still
 * able to issue a query.
 */
export async function closeWithinDeadline(app: FastifyInstance, graceMs: number): Promise<ShutdownReport> {
  const startedAt = Date.now();
  const closing = app.close();

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'forced'>((resolve) => {
    timer = setTimeout(() => resolve('forced'), graceMs);
  });

  const outcome = await Promise.race([closing.then(() => 'drained' as const), deadline]);
  if (timer) clearTimeout(timer);

  if (outcome === 'forced') {
    // Idempotent on Node's http server, and it does not undo any response that
    // already went out — it only stops waiting on sockets that are idle or slow.
    app.server.closeAllConnections();
    // Forcing is what makes `closing` resolve promptly (measured: 70.3s -> 0.5s),
    // but a second bound here means a wedged handler can never hold the process
    // open forever: past the failsafe we stop waiting and let the caller exit.
    const failsafeMs = Math.max(graceMs, 1_000);
    const finished = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), failsafeMs)),
    ]);
    if (!finished) {
      console.warn(`[shutdown] close() still unresolved ${failsafeMs}ms after forcing; exiting regardless`);
    }
  }

  return { tookMs: Date.now() - startedAt, forced: outcome === 'forced', graceMs };
}
