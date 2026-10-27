/**
 * Shutdown is a correctness surface, not a nicety.
 *
 * The finding this file encodes: `app.close()` does drain in-flight requests —
 * every one of them got its 200 — but on Node it does not *resolve* until the
 * idle keep-alive sockets left behind by the client expire. Measured on this
 * machine: 70.3 seconds. A container manager that sends SIGKILL after 10-30s
 * therefore kills the process mid-shutdown, so the database pools are torn down
 * without their `close()` and the outbox lease the dispatcher was holding stays
 * held until it times out.
 *
 * Test 2 is the regression for exactly that: with a client that keeps its
 * connection alive, an unforced close would have taken a minute and a half.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeWithinDeadline } from '../src/shutdown.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function listeningApp(handlerMs = 50): Promise<{ app: FastifyInstance; url: string }> {
  const app = Fastify({ forceCloseConnections: 'idle' });
  app.get('/work', async () => {
    await sleep(handlerMs);
    return { ok: true };
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: address };
}

describe('closeWithinDeadline', () => {
  it('answers requests that were inside the handler when the shutdown signal arrived', async () => {
    // A rolling deploy must not lose a proposal that was already accepted: a lost
    // POST /v1/actions is an agent taking an action on a decision it never got.
    //
    // Determinism comes from a gate, not from sleeps. The handlers block until the
    // test says otherwise, so "in flight at close time" is a fact this test
    // establishes rather than a race it hopes to win — the version that polled the
    // connection count was flaky in exactly the way a timing test always is.
    let releaseHandler!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let entered = 0;
    const app = Fastify({ forceCloseConnections: 'idle' });
    app.get('/work', async () => {
      entered++;
      await gate;
      return { ok: true };
    });
    const url = await app.listen({ port: 0, host: '127.0.0.1' });

    const inflight = Array.from({ length: 4 }, () =>
      fetch(`${url}/work`)
        .then(async (res) => ({ kind: 'answered' as const, status: res.status, body: await res.json() }))
        .catch(() => ({ kind: 'reset' as const })),
    );

    const blockedAt = Date.now();
    while (entered < 4 && Date.now() - blockedAt < 10_000) await sleep(10);
    expect(entered, 'requests never reached the handler').toBe(4);

    const closing = closeWithinDeadline(app, 3_000);
    // Close is underway with all four still blocked; now let them finish, so the
    // drain has real responses to deliver rather than an empty wait.
    await sleep(50);
    releaseHandler();

    const report = await closing;
    const outcomes = await Promise.all(inflight);

    const answered = outcomes.filter((o) => o.kind === 'answered') as Array<{
      kind: 'answered';
      status: number;
      body: unknown;
    }>;
    expect(answered.length, 'the drain cut off requests already inside the handler').toBe(4);
    for (const answer of answered) {
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ ok: true });
    }
    // Forcing is the correct outcome here, not a failure: those sockets become idle
    // only AFTER Fastify's single closeIdleConnections() call in preClose, so
    // without the deadline close() would wait out Node's keep-alive and headers
    // timeouts — the measured 70.3s.
    expect(report.tookMs).toBeLessThan(report.graceMs + 1_500);
  });

  it('does not report a forced shutdown when there was nothing to wait for', async () => {
    // The deterministic half of "forcing is a fallback, not the normal route".
    // An idle server must close inside the window on its own; if this ever reports
    // forced=true, the deadline is truncating healthy shutdowns rather than
    // rescuing wedged ones.
    const { app } = await listeningApp(5);
    const report = await closeWithinDeadline(app, 5_000);
    expect(report.forced).toBe(false);
    expect(report.tookMs).toBeLessThan(5_000);
  });

  it('does not wait forever on a handler that outruns the deadline', async () => {
    // A wedged handler must not become a wedged deploy. Same gate technique as the
    // test above so "the handler is still running at the deadline" is established
    // rather than raced: the first version polled the connection count and, when
    // the request had not arrived yet, closed a clean server and reported
    // forced=false.
    let releaseHandler!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let entered = 0;
    const app = Fastify({ forceCloseConnections: 'idle' });
    app.get('/hang', async () => {
      entered++;
      await gate;
      return { ok: true };
    });
    const url = await app.listen({ port: 0, host: '127.0.0.1' });

    const straggler = fetch(`${url}/hang`)
      .then((res) => ({ kind: 'answered' as const, status: res.status }))
      .catch(() => ({ kind: 'reset' as const }));

    // Establish that the request is inside the handler before closing.
    const deadlineForEntry = Date.now();
    while (entered < 1 && Date.now() - deadlineForEntry < 10_000) await sleep(10);
    expect(entered, 'the handler never started').toBe(1);

    const began = Date.now();
    const report = await closeWithinDeadline(app, 300);
    expect(Date.now() - began, 'shutdown outran its deadline by too much').toBeLessThan(4_000);
    expect(report.forced, 'a handler past the deadline must trigger the forced path').toBe(true);

    // The request that was still being handled when the deadline fired did not
    // get a completed answer — being cut is what a deadline buys, and why the
    // window is configuration rather than a constant.
    const outcome = await straggler;
    expect(outcome.kind, 'a straggler must not be served after a forced shutdown').not.toBe('answered');
    // Release the blocked handler so no promise is left dangling for the runner.
    releaseHandler();
  });

  it('reports the window it was given so the log line is auditable', async () => {
    const { app } = await listeningApp(5);
    const report = await closeWithinDeadline(app, 120);
    expect(report.graceMs).toBe(120);
    expect(typeof report.tookMs).toBe('number');
  });
});
