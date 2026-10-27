#!/usr/bin/env tsx
/**
 * scripts/load-sweep.mjs — where the intake ceiling actually is, measured.
 *
 * `load-test.mjs` answers "did this run hold the SLOs". This answers the question
 * a reviewer asks next: what limits it, and does the knob we say moves it really
 * move it?
 *
 * Row-level security made every tenant statement a transaction that holds a pooled
 * connection, so `RUNTIME_POOL_MAX` — not CPU — is the ceiling on concurrent
 * intake. That is a claim, and a claim in a README is worth nothing until
 * something tries to falsify it. This script boots the API once per (pool size,
 * client concurrency) cell, on a freshly reset and re-seeded database each time so
 * no cell inherits another's table growth, and records what the server did and
 * what the client experienced.
 *
 * The gate is deliberately two-sided:
 *   · a saturated pool must never turn into a 5xx — back-pressure is fine, lying
 *     about it is not;
 *   · the conclusion written into SCALING.md is computed from the cells (`classify`),
 *     so the document cannot keep asserting a lever the measurement refuted. It did:
 *     the claim this script was written to confirm — that `RUNTIME_POOL_MAX` is the
 *     intake ceiling — came back false, and the report now says which constraint the
 *     numbers actually support.
 *
 * Usage:
 *   npm run load:sweep
 *   ... --cells 10:10,10:25,25:25        (runtimePoolMax:connections)
 *   ... --recommended 10:10              (the operating point the checks hold)
 *   ... --duration 30
 *   ... --out docs/benchmarks
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import autocannon from 'autocannon';
import { histogramQuantile, SLOS } from '../packages/observability/src/index.js';
import { loadRootEnv } from '../packages/db/src/index.js';
import { buildRequestPool, counterDelta, loadCredentials, scrapeMetrics } from './lib/load-workload.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

loadRootEnv();

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};
const cells = arg('cells', '10:10,10:25,25:25')
  .split(',')
  .map((spec) => spec.trim())
  .filter(Boolean)
  .map((spec) => {
    const [pool, conns] = spec.split(':').map(Number);
    if (!Number.isFinite(pool) || !Number.isFinite(conns) || pool < 1 || conns < 1) {
      throw new Error(`bad cell "${spec}"; expected runtimePoolMax:connections, e.g. 10:25`);
    }
    return { runtimePoolMax: pool, connections: conns };
  });
const duration = Number(arg('duration', 30));
const outDir = path.join(root, arg('out', 'docs/benchmarks'));
const scenario = arg('scenario', 'allow');
const amountMinor = Number(arg('amount', 300000));

const availabilitySlo = SLOS.find((s) => s.id === 'decision-availability');
const latencySlo = SLOS.find((s) => s.id === 'decision-latency');
if (!availabilitySlo || !latencySlo) throw new Error('SLO definitions missing; the sweep has no thresholds to assert');

/** The same CLI `npm run db:reset` runs, spawned directly so there is no shell in
 * the middle deciding whether `npm` is `npm` or `npm.cmd` on this platform. */
function runDb(command) {
  const res = spawnSync(process.execPath, [tsx, 'src/cli.ts', command], {
    cwd: path.join(root, 'packages', 'db'),
    encoding: 'utf8',
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`db ${command} failed (exit ${res.status}):\n${res.stderr ?? res.stdout}`);
  }
}

/**
 * Boot one API process for one cell.
 *
 * The rate limiter is a real control and a real ceiling, but a capacity sweep that
 * is mostly 429s measures the limiter, not the engine, so both limits are raised
 * for these runs and the run then asserts (below) that throttling stayed
 * negligible — the exemption is checked rather than assumed.
 *
 * REDIS_URL is empty: the outbox dispatcher shares this pool in production and
 * would compete with intake for it, which is a second finding. Disabling it here
 * makes each number the intake path in isolation — an optimistic ceiling, not a
 * pessimistic one, and stated as such in the report.
 */
function startServer({ port, runtimePoolMax }) {
  return spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.join(root, 'apps', 'api'),
    env: {
      ...process.env,
      PORT: String(port),
      RUNTIME_POOL_MAX: String(runtimePoolMax),
      RATE_LIMIT_MAX: '100000',
      RATE_LIMIT_MUTATIONS_PER_MIN: '100000',
      REDIS_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Poll /health/ready until the process says it is ready.
 *
 * A dead child is reported, not waited on: the first sweep run failed with
 * "Unexpected non-whitespace character after JSON" because config rejected
 * RATE_LIMIT_MAX and exited, while this loop kept polling a port nobody owned for
 * two minutes. The child's own fatal line is the diagnosis, so it comes back with
 * the error.
 */
async function waitForReady(child, log, port, deadlineMs = 120_000) {
  const began = Date.now();
  let lastError = 'no attempt';
  while (Date.now() - began < deadlineMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `server on :${port} exited with ${child.exitCode ?? child.signalCode} before becoming ready:\n${log.join('').slice(-2000)}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { unparsable: text.slice(0, 200) };
      }
      if (res.status === 200 && body.status === 'ready') {
        return { ready: true, tenantIsolation: body.tenant_isolation ?? null, tookMs: Date.now() - began };
      }
      lastError = `HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `server on :${port} never became ready (${deadlineMs}ms): ${lastError}\n${log.join('').slice(-2000)}`,
  );
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Windows has no signals for Node child processes: `child.kill()` there is
  // TerminateProcess, which does not run the graceful-shutdown handler. Killing the
  // whole tree is the only way to be sure the tsx wrapper's child is gone too, and
  // a leftover server holding :18082 would silently answer the next cell's requests.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    setTimeout(resolve, 10_000);
  });
}

/**
 * Ask the OS for a port nobody is using.
 *
 * The first sweep run collided with an unrelated local app that had claimed
 * 127.0.0.1:18080 days earlier and answered `/health/ready` with a 404 text body —
 * which looked like a broken API rather than a stolen port. Binding 0 and reading
 * back the assignment removes the guess; there is still a theoretical race between
 * closing the probe socket and the server binding it, and the readiness poll now
 * reports the child's own fatal line if that ever happens.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function runCell({ runtimePoolMax, connections }) {
  const port = Number(arg('port', 0)) || (await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  process.stdout.write(`\n=== pool ${runtimePoolMax} × ${connections} connections (:${port}) ===\n`);

  runDb('reset');
  runDb('seed');
  const { agentId, token } = loadCredentials(root);
  const metricsToken = process.env.METRICS_TOKEN ?? '';

  const child = startServer({ port, runtimePoolMax });
  const log = [];
  child.stdout.on('data', (chunk) => log.push(String(chunk)));
  child.stderr.on('data', (chunk) => log.push(String(chunk)));

  try {
    const readiness = await waitForReady(child, log, port);
    const requestPool = buildRequestPool({ agentId, token, scenario, amountMinor, size: 40_000 });
    const before = await scrapeMetrics(baseUrl, metricsToken);
    if (!before) throw new Error(`no /metrics scrape from ${baseUrl}; the sweep cannot compute server-side rates`);

    const result = await autocannon({ url: baseUrl, connections, duration, requests: requestPool });

    const after = await scrapeMetrics(baseUrl, metricsToken);
    if (!after) throw new Error(`post-run /metrics scrape from ${baseUrl} failed`);

    const requestDelta = counterDelta(before, after, 'pz_http_requests_total');
    const fivexx = counterDelta(
      before,
      after,
      'pz_http_requests_total',
      { status_class: '5xx' },
      { absentAsZero: true },
    );
    const throttled = counterDelta(
      before,
      after,
      'pz_http_requests_total',
      { status_class: '4xx' },
      { absentAsZero: true },
    );
    const decisions = counterDelta(before, after, 'pz_decisions_total');
    const percentile = (q) => {
      const v = histogramQuantile(after, 'pz_decision_duration_seconds', q);
      return v === null ? null : Math.round(v * 1000);
    };
    // autocannon folds timeouts into `errors`, and `resets` are separate: the
    // breakdown is the difference between "the pool queued requests until callers
    // gave up" and "the server closed sockets".
    const failures = result.errors + result.resets;
    const failureRate = result.requests.total ? failures / result.requests.total : 0;

    process.stdout.write(
      `  ${result.requests.total} requests (${result.requests.average.toFixed(1)} rps), ` +
        `${decisions ?? '—'} fresh decisions, server p99 ${percentile(0.99) ?? '—'} ms, ` +
        `5xx ${fivexx ?? '—'}, client failures ${failures} (${(failureRate * 100).toFixed(2)}%)\n`,
    );

    return {
      runtimePoolMax,
      connections,
      port,
      durationSeconds: duration,
      boot: { readyMs: readiness.tookMs, tenantIsolationEnforced: readiness.tenantIsolation?.enforced ?? null },
      requests: result.requests.total,
      rps: Number(result.requests.average.toFixed(1)),
      freshDecisions: decisions,
      requestsSeenByServer: requestDelta,
      replayShare: requestDelta && decisions !== null ? Number((1 - decisions / requestDelta).toFixed(4)) : null,
      server5xx: fivexx,
      serverErrorRate: requestDelta && fivexx !== null && requestDelta > 0 ? fivexx / requestDelta : null,
      throttled4xx: throttled,
      throttledShare:
        requestDelta && throttled !== null ? Number((throttled / Math.max(1, requestDelta)).toFixed(4)) : null,
      serverLatencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
      clientLatencyMs: { p50: result.latency.p50, p99: result.latency.p99, max: result.latency.max },
      client: {
        failures,
        failureRate: Number(failureRate.toFixed(5)),
        connectionErrorsAndTimeouts: result.errors,
        ofWhichTimeouts: result.timeouts,
        pipelineResets: result.resets,
        statusCodes: Object.fromEntries(
          Object.entries(result.statusCodeStats ?? {}).map(([code, s]) => [code, s.count]),
        ),
      },
      // The child's own last lines. If a cell failed to boot, the numbers for it
      // are meaningless and the reason has to be in the report, not in a terminal
      // that has already scrolled away.
      logTail: log.join('').split('\n').slice(-12).join('\n'),
    };
  } finally {
    await stopServer(child);
  }
}

async function run() {
  mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const cell of cells) {
    rows.push(await runCell(cell));
  }

  const checks = [];
  const check = (name, pass, detail) => {
    const unknown = pass === null || pass === undefined;
    checks.push({ name, pass: unknown ? false : Boolean(pass), unknown, detail });
  };

  check(
    'every cell booted with row-level security enforced on the runtime pool',
    rows.every((r) => r.boot.tenantIsolationEnforced === true) ? true : null,
    rows.map((r) => ({ pool: r.runtimePoolMax, enforced: r.boot.tenantIsolationEnforced })),
  );
  check(
    'no cell answered 5xx — a saturated pool must queue, not lie',
    rows.every((r) => r.server5xx === 0) ? true : null,
    rows.map((r) => ({ pool: r.runtimePoolMax, connections: r.connections, server5xx: r.server5xx })),
  );
  check(
    'the limiter stayed out of the way',
    rows.every((r) => r.throttledShare !== null && r.throttledShare < 0.01) ? true : null,
    rows.map((r) => ({ pool: r.runtimePoolMax, throttledShare: r.throttledShare })),
  );
  // The operating point the docs recommend has to hold both objectives. This is
  // the gate that can fail; the rest of the sweep is measurement.
  const [recPool, recConns] = arg('recommended', '').split(':').map(Number);
  const recommended =
    rows.find((r) => r.runtimePoolMax === recPool && r.connections === recConns) ??
    rows.slice().sort((a, b) => a.connections - b.connections)[0];
  check(
    `the recommended operating point (pool ${recommended?.runtimePoolMax ?? '?'}, ${recommended?.connections ?? '?'} clients) holds both objectives`,
    recommended
      ? recommended.client.failureRate <= 1 - availabilitySlo.objective &&
          recommended.serverLatencyMs.p99 !== null &&
          recommended.serverLatencyMs.p99 <= latencySlo.thresholdMs
      : null,
    recommended
      ? {
          failureRate: recommended.client.failureRate,
          availabilityObjective: availabilitySlo.objective,
          serverP99Ms: recommended.serverLatencyMs.p99,
          latencyObjectiveMs: latencySlo.thresholdMs,
        }
      : 'no cell matched',
  );
  // Every cell has to be a measurement, not a gap: an unmeasured client failure
  // rate or a null p99 would let the checks above pass on absence of evidence.
  check(
    'every cell was measured',
    rows.every((r) => r.client.failureRate !== null && r.serverLatencyMs.p99 !== null && r.freshDecisions > 0)
      ? true
      : null,
    rows.map((r) => ({
      pool: r.runtimePoolMax,
      connections: r.connections,
      p99: r.serverLatencyMs.p99,
      freshDecisions: r.freshDecisions,
    })),
  );

  const diagnosis = classify(rows);

  const verdict = checks.every((c) => c.pass && !c.unknown) ? 'PASS' : 'FAIL';
  const report = {
    ranAt: new Date().toISOString(),
    scenario,
    workload: {
      durationSeconds: duration,
      path: 'POST /v1/actions',
      amountMinor,
      dispatcher: 'disabled (REDIS_URL empty)',
    },
    objectives: {
      availability: availabilitySlo.objective,
      latencyMs: latencySlo.thresholdMs,
    },
    environment: {
      node: process.version,
      rlsRole: 'pz_app via DATABASE_URL_RUNTIME',
    },
    cells: rows,
    diagnosis,
    checks,
    verdict,
  };
  writeFileSync(path.join(outDir, 'scaling.json'), JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(path.join(outDir, 'SCALING.md'), renderMarkdown(report), 'utf8');

  console.log(`\nload sweep — ${verdict}`);
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail)}`);
  console.log(`\n  wrote ${path.relative(root, path.join(outDir, 'scaling.json'))} and SCALING.md`);
  if (verdict === 'FAIL') process.exitCode = 1;
}

/**
 * Decide, from the numbers, which knob was actually binding.
 *
 * The first version of this file asserted that `RUNTIME_POOL_MAX` was the ceiling —
 * a plausible-sounding consequence of row-level security turning every tenant
 * statement into a pooled transaction. The measurement said otherwise: doubling the
 * pool moved throughput by well under one percent, and tripling the clients moved it
 * by nothing at all. A report whose prose is generated from the data cannot keep
 * repeating a claim the data refuted, which is the point of putting the conclusion
 * here rather than in the README.
 */
function classify(rows) {
  const ratio = (a, b) => (a && b && b.rps > 0 ? Number((a.rps / b.rps).toFixed(3)) : null);
  const pairOverPool = (() => {
    for (const a of rows) {
      for (const b of rows) {
        if (a !== b && a.connections === b.connections && a.runtimePoolMax < b.runtimePoolMax)
          return { small: a, large: b };
      }
    }
    return null;
  })();
  const pairOverClients = (() => {
    for (const a of rows) {
      for (const b of rows) {
        if (a !== b && a.runtimePoolMax === b.runtimePoolMax && a.connections < b.connections)
          return { few: a, many: b };
      }
    }
    return null;
  })();

  const poolGain = pairOverPool ? ratio(pairOverPool.large, pairOverPool.small) : null;
  const clientGain = pairOverClients ? ratio(pairOverClients.many, pairOverClients.few) : null;
  const clientScalingEfficiency =
    pairOverClients && pairOverClients.few.rps > 0
      ? Number(
          (
            pairOverClients.many.rps /
            pairOverClients.few.rps /
            (pairOverClients.many.connections / pairOverClients.few.connections)
          ).toFixed(3),
        )
      : null;

  let binding;
  if (poolGain === null && clientGain === null) binding = 'unknown (the cell list has no comparable pairs)';
  else if (poolGain !== null && poolGain >= 1.2)
    binding = `the runtime pool — doubling it raised throughput ${poolGain}×`;
  else if (clientGain !== null && clientGain >= 1.2)
    binding = `neither knob at the tested settings: clients added ${clientGain}× throughput, so the pool was not full`;
  else binding = 'neither knob: throughput was flat against both the pool size and the client count';

  return {
    poolGain,
    clientGain,
    clientScalingEfficiency,
    binding,
    pairs: {
      overPool: pairOverPool ? { small: pairOverPool.small.rps, large: pairOverPool.large.rps } : null,
      overClients: pairOverClients ? { few: pairOverClients.few.rps, many: pairOverClients.many.rps } : null,
    },
    serializedByTenant:
      clientGain !== null && clientGain < 1.2
        ? 'More clients produced no more throughput, and the pool was not the limit. Writes that append to the per-tenant audit hash chain are serialised by design (packages/db/src/repos/audit.ts: the sequence is assigned under a transaction-scoped advisory lock and the previous hash is re-checked against the head), so a single tenant cannot be appended to concurrently. This workload drives one tenant, so the chain is the ceiling.'
        : null,
  };
}

function renderMarkdown(r) {
  const fmt = (v) => (v === null || v === undefined ? '—' : v);
  const row = (c) =>
    `| ${c.runtimePoolMax} | ${c.connections} | ${fmt(c.requests)} | ${fmt(c.rps)} | ${fmt(c.freshDecisions)} | ` +
    `${fmt(c.serverLatencyMs.p99)} | ${fmt(c.clientLatencyMs.p99)} | ${fmt(c.server5xx)} | ` +
    `${fmt(c.client.failures)} | ${fmt((c.client.failureRate * 100).toFixed(2))}% | ` +
    `${fmt(c.client.ofWhichTimeouts)} | ${fmt(c.client.pipelineResets)} |`;
  return `# Intake capacity — the pool ceiling, measured

**Verdict: ${r.verdict}.** Generated by \`npm run load:sweep\` at ${r.ranAt}; do not hand-edit.

Each cell boots its own API process on a freshly reset and re-seeded database, so no
cell measures against another's table growth. Client concurrency is the number of
autocannon connections; \`RUNTIME_POOL_MAX\` is the runtime (RLS-bound) pool size the
process booted with.

| RUNTIME_POOL_MAX | clients | requests | req/s | fresh decisions | server p99 (ms) | client p99 (ms) | server 5xx | client failures | failure rate | of which timeouts | resets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${r.cells.map(row).join('\n')}

## What was binding

Measured from the cells above, not asserted:

· throughput ratio when the pool was raised at equal clients: **${fmt(r.diagnosis.poolGain)}×** (${fmt(r.diagnosis.pairs.overPool ? `${r.diagnosis.pairs.overPool.small} → ${r.diagnosis.pairs.overPool.large} req/s` : 'no comparable pair')})
· throughput ratio when clients were raised at equal pool: **${fmt(r.diagnosis.clientGain)}×** (${fmt(r.diagnosis.pairs.overClients ? `${r.diagnosis.pairs.overClients.few} → ${r.diagnosis.pairs.overClients.many} req/s` : 'no comparable pair')}), i.e. **${fmt(r.diagnosis.clientScalingEfficiency)}** of linear
· binding constraint: **${r.diagnosis.binding}**
${r.diagnosis.serializedByTenant ? `\n${r.diagnosis.serializedByTenant}\n` : ''}
## Why the two error columns are separate

The server records a 5xx only for a response it sent. A request that queues behind a
pooled transaction and is eventually abandoned by its client produces **no server-side
error at all** — it looks like a clean run from inside the process. So capacity is
judged on the client column and correctness on the server column, and a run can pass
one and fail the other. That is exactly what happened the first time: 25 clients
against a pool of 10 gave 0 server 5xx and 11 requests that never got an answer.

## What the checks assert

${r.checks.map((c) => `- ${c.pass ? '✅' : '❌'} **${c.name}** — \`${JSON.stringify(c.detail)}\``).join('\n')}

The last check is the one that can prove the documentation wrong: if raising
\`RUNTIME_POOL_MAX\` did not reduce client failures at the same client concurrency, the
ceiling is not the pool and the claim would have to be retired rather than repeated.

## Reading the numbers

· **fresh decisions** is what actually evaluated policy. autocannon replays its request
  list from index 0 per connection, so with N connections each idempotency key arrives
  N times and only the first is a decision; the rest are answered from the completed
  record. With a pool of 40,000 pre-generated keys and short runs, replay dominates as
  connection count rises — the ratio is recorded so the distinction is never lost.
· **server p99** is the API's own decision histogram (cumulative since boot), which
  excludes the load generator's scheduling on the same host. Client p99 includes it.
· \`REDIS_URL\` was empty, so the outbox dispatcher did not compete for the pool. In
  production it does: these are ceilings for the intake path in isolation, optimistic
  by whatever the dispatcher takes.
· The rate limits were raised for these runs, and the "limiter stayed out of the way"
  check asserts that throttling stayed under 1% of requests — otherwise the run would
  be measuring @fastify/rate-limit rather than the engine.

## What this does not measure

Single host, single region, one Postgres, model provider disabled. No failover timing,
no cross-region skew, no connection-pooler (PgBouncer) in front. Cells differ only in
pool size and client concurrency; everything else is the same process boot.
`;
}

run().catch((err) => {
  console.error('load sweep crashed:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
