#!/usr/bin/env tsx
/**
 * scripts/load-test.mjs — the intake path under load, measured on the server.
 *
 * Two things make this more than "curl it fast and note the number".
 *
 * First, the reported latency percentiles come from the API's own histogram,
 * scraped before and after the run, not from the client's view of round trips.
 * A load generator on the same host reports a number that includes its own
 * scheduling; the server reports the decision. Both are recorded and both are
 * printed, because a gap between them is itself a finding.
 *
 * Second, it can fail. The thresholds are the SLOs in
 * `packages/observability/src/slos.ts`, read from there rather than retyped, so
 * the benchmark and the objective cannot drift into agreeing with each other by
 * accident.
 *
 * This matters most here because of row-level security: every tenant statement is
 * now a transaction holding a pooled connection, which makes `RUNTIME_POOL_MAX` the
 * first suspect for any concurrency limit. `load-sweep.mjs` tested that suspicion and
 * it did not hold — doubling the pool moved throughput by under one percent — so this
 * file reports what the client experienced next to what the server recorded, and the
 * ceiling is described by the sweep's numbers rather than by a guess about the pool.
 *
 * Usage:
 *   node scripts/load-test.mjs --url http://127.0.0.1:8080 --token $METRICS_TOKEN \
 *     --connections 25 --duration 30 --amount 300000
 *   ... --scenario deny      (over-limit amount; exercises the deny path, no permit)
 *   ... --out docs/benchmarks
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';
import { createDb, loadRootEnv } from '@permitzero/db';
import { SLOS, histogramQuantile, sumBy } from '../packages/observability/src/index.js';
import { buildRequestPool, counterDelta, loadCredentials, scrapeMetrics } from './lib/load-workload.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The root `.env` holds METRICS_TOKEN and DATABASE_URL_RUNTIME. Without this the
// run silently loses the server-side half of every assertion — it completes the
// load, cannot scrape /metrics, and reports the objective on client latency alone.
loadRootEnv();
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};
const num = (name, def) => Number(arg(name, def));

const baseUrl = arg('url', 'http://127.0.0.1:8080');
const metricsToken = arg('token', process.env.METRICS_TOKEN ?? '');
const connections = num('connections', 25);
const duration = num('duration', 30);
const amountMinor = num('amount', 300000);
const scenario = arg('scenario', 'allow');
const outDir = path.join(root, arg('out', 'docs/benchmarks'));

const latencySlo = SLOS.find((s) => s.id === 'decision-latency');
const availabilitySlo = SLOS.find((s) => s.id === 'decision-availability');
if (!latencySlo || !availabilitySlo)
  throw new Error('SLO definitions missing; the benchmark has no thresholds to assert');

function statusClasses(metrics) {
  const out = {};
  for (const sample of metrics?.get('pz_http_requests_total')?.samples ?? []) {
    const cls = sample.labels.status_class ?? 'other';
    out[cls] = (out[cls] ?? 0) + sample.value;
  }
  return out;
}

async function explainEvidence(tenantId) {
  const url = process.env.DATABASE_URL_RUNTIME || process.env.DATABASE_URL;
  if (!url || !tenantId) return { error: 'no DATABASE_URL_RUNTIME; plans not captured' };
  const db = createDb(url, { max: 1 });
  const plans = {};
  try {
    // Parameterised rather than interpolated: this runs the same statements the
    // repositories run, and a benchmark script that builds SQL by concatenation is
    // a bad example to leave in the repo.
    const queries = {
      'actions by tenant + state (approval queue)': () =>
        db.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT * FROM actions WHERE tenant_id = ${tenantId} AND state = 'APPROVAL_REQUIRED'
          ORDER BY created_at LIMIT 50`,
      'actions by tenant + time (list page)': () =>
        db.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT * FROM actions WHERE tenant_id = ${tenantId} ORDER BY created_at DESC LIMIT 50`,
      'audit by tenant + time (evidence page)': () =>
        db.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT * FROM audit_events WHERE tenant_id = ${tenantId} ORDER BY event_time DESC LIMIT 50`,
      'outbox claim (dispatcher tick)': () =>
        db.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT * FROM outbox_events WHERE status IN ('PENDING','FAILED')
            AND next_attempt_at <= now() ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED`,
    };
    for (const [label, run] of Object.entries(queries)) {
      try {
        const rows = await run();
        const plan = rows?.[0]?.Plan ?? rows?.Plan;
        plans[label] = {
          node: plan?.['Node Type'],
          index: plan?.['Index Name'] ?? null,
          parallel: Boolean(plan?.['Parent Relationship'] === 'Partial'),
          actualMs: plan?.['Actual Total Time'],
          plannedMs: plan?.['Plan Total Time'],
          rows: plan?.['Actual Rows'],
          sharedHits: plan?.['Shared Hit Blocks'] ?? null,
          sharedReads: plan?.['Shared Read Blocks'] ?? null,
        };
      } catch (err) {
        plans[label] = { error: err.message.slice(0, 160) };
      }
    }
  } finally {
    await db.sql.end({ timeout: 2 });
  }
  return plans;
}

async function main() {
  const { agentId, token, tenantId } = loadCredentials(root);

  // The keys are pre-generated because autocannon cycles a fixed `requests` array
  // and its `setupClient` hook runs once per connection. The pool is sized above
  // what a run can issue; if it ever ran out, autocannon would wrap and the tail
  // would measure replays, so the fresh-decision count is asserted below rather
  // than assumed.
  const requestPool = buildRequestPool({ agentId, token, scenario, amountMinor, size: 40_000 });

  // A counter the run has to move, so a "0 requests" result can never be read as
  // a clean pass.
  const before = await scrapeMetrics(baseUrl, metricsToken);
  const startedAt = new Date().toISOString();

  const result = await autocannon({
    url: baseUrl,
    connections,
    duration,
    requests: requestPool,
  });

  const after = await scrapeMetrics(baseUrl, metricsToken);
  const finishedAt = new Date().toISOString();

  const serverPercentile = (q) => (after ? histogramQuantile(after, 'pz_decision_duration_seconds', q) : null);
  // Counters are monotonic per process, so a decrease means the server restarted
  // partway through and every rate below would be fiction — reported as null.
  // A status-class series that never appeared is zero, not unknown: a clean run has
  // no `{status_class="5xx"}` series at all.
  const delta = (name, filter) => counterDelta(before, after, name, filter, { absentAsZero: true });
  const decisionDelta = delta('pz_decisions_total');
  const fivexxDelta = delta('pz_http_requests_total', { status_class: '5xx' });
  const throttledDelta = delta('pz_http_requests_total', { status_class: '4xx' });
  const requestDelta = delta('pz_http_requests_total');
  const decisionCount = after ? sumBy(after, 'pz_decision_duration_seconds_count') : null;

  const serverErrorRate = requestDelta && fivexxDelta !== null && requestDelta > 0 ? fivexxDelta / requestDelta : null;

  const p99Seconds = serverPercentile(0.99);
  const p99Ms = p99Seconds === null ? null : Math.round(p99Seconds * 1000);

  // autocannon counts a timeout inside `errors` as well, so the three counters are
  // reported separately rather than as one "errors" number. The distinction is the
  // finding: a request that never completed because the socket was refused, reset
  // or gave up is a client-visible outage with no server-side 5xx to point at, and
  // a server counter alone would report it as a clean run.
  const clientFailures = result.errors + result.resets;
  const clientFailureRate = result.requests.total ? clientFailures / result.requests.total : 0;
  const errorBreakdown = {
    connectionErrorsAndTimeouts: result.errors,
    ofWhichTimeouts: result.timeouts,
    pipelineResets: result.resets,
    expectationMismatches: result.mismatches,
    statusCodes: Object.fromEntries(Object.entries(result.statusCodeStats ?? {}).map(([code, s]) => [code, s.count])),
  };

  const checks = [];
  // A null here means "could not be measured" — the scrape was unavailable, the
  // series absent, the server not listening. Passing a check on that would be the
  // same mistake this file exists to catch: the first version of these guards let
  // four of six pass against a run where the server never started at all and every
  // request was a transport error, because `null` happened to satisfy the
  // comparisons. Unknown is now a failure, stated as its own outcome.
  const check = (name, pass, detail) => {
    const unknown = pass === null || pass === undefined;
    checks.push({ name, pass: unknown ? false : Boolean(pass), unknown, detail });
  };
  const known = (v) => (v === null || v === undefined ? null : v);

  check('load actually reached the server', result.requests.total > 0, { requests: result.requests.total });
  check('the server was reachable and scraped', after !== null && before !== null, {
    scrapedBefore: before !== null,
    scrapedAfter: after !== null,
    metricsTokenConfigured: metricsToken.length > 0,
  });
  check('the server recorded the decisions it made', known(decisionDelta) === null ? null : decisionDelta > 0, {
    decisionsDelta: decisionDelta,
    histogramCount: decisionCount,
  });
  check(
    `decision p99 within the ${Math.round(latencySlo.thresholdMs)}ms objective`,
    // The server histogram is authoritative; the client number is only a
    // fallback, and is marked as such below rather than silently substituted.
    p99Ms === null ? result.latency.p99 <= latencySlo.thresholdMs : p99Ms <= latencySlo.thresholdMs,
    {
      serverP99Ms: p99Ms,
      clientP99Ms: result.latency.p99,
      fallbackUsed: p99Ms === null,
      objective: latencySlo.objective,
    },
  );
  check(
    'server-observed availability held under load',
    known(serverErrorRate) === null ? null : serverErrorRate <= 1 - availabilitySlo.objective,
    { serverErrorRate, objective: availabilitySlo.objective },
  );
  // The same objective, measured from outside. A saturated connection pool does not
  // answer 500: the request sits until the generator gives up, so the server's
  // error rate stays flat while callers time out. Asserting only the server number
  // would certify a run in which real clients could not get an answer, and the
  // first version of this file did exactly that — it passed on 0 server 5xx while
  // 11 requests never completed.
  check(
    'client-observed availability held under load',
    known(requestDelta) === null ? null : clientFailureRate <= 1 - availabilitySlo.objective,
    { clientFailureRate, clientFailures, objective: availabilitySlo.objective, ...errorBreakdown },
  );
  check(
    'the server answered every request it accepted without a 5xx',
    known(fivexxDelta) === null ? null : fivexxDelta === 0,
    { server5xx: fivexxDelta, runtimePoolMax: process.env.RUNTIME_POOL_MAX ?? '(default 10)' },
  );
  // The check that makes the difference between a capacity measurement and a
  // measurement of the rate limiter. At the deployed defaults most of a benchmark
  // run is answered 429 before ever reaching the policy engine, and the latency
  // numbers then look excellent because they describe twelve requests rather than
  // thirty-four thousand. Failing here says "raise the limits or shrink the run";
  // quietly reporting the surviving requests as the result would not.
  check(
    'the run measured the engine, not the rate limiter',
    known(requestDelta) === null || known(throttledDelta) === null
      ? null
      : throttledDelta / Math.max(1, requestDelta) < 0.01,
    {
      throttled: throttledDelta,
      requestsSeen: requestDelta,
      note: "the 4xx share as counted by the server. The server's configured limit is not visible from the client, so this is measured, not inferred from this process's environment.",
    },
  );

  const plans = await explainEvidence(tenantId);

  const report = {
    ranAt: startedAt,
    finishedAt,
    target: baseUrl,
    scenario,
    workload: {
      connections,
      durationSeconds: scenario === 'allow' ? duration : duration,
      amountMinor,
      path: 'POST /v1/actions',
    },
    statusClasses: { before: statusClasses(before), after: statusClasses(after) },
    // autocannon replays its `requests` array from index 0 on EVERY connection,
    // so with N connections the same idempotency key arrives N times and only the
    // first is a fresh decision; the rest are answered from the completed record.
    // That is a real and cheap path worth measuring, but it is not the decision
    // path, and reporting the combined number as decision throughput would
    // overstate capacity by roughly `connections`-fold. Both rates are therefore
    // recorded, and the p99 above is computed from the server's own decision
    // histogram, which only the fresh ones enter.
    pathMix: {
      requestsCompleted: result.requests.total,
      freshDecisions: decisionDelta,
      replayedOrOther: requestDelta === null || decisionDelta === null ? null : requestDelta - decisionDelta,
      replayShare:
        requestDelta && decisionDelta !== null ? Number((1 - decisionDelta / requestDelta).toFixed(4)) : null,
      explanation:
        'fresh decisions are the ones that evaluated policy; the remainder answered 200 from the completed idempotency record',
    },
    client: {
      requests: result.requests.total,
      // `requests.average` is completions per second. `throughput.average` is
      // BYTES per second, and labelling it req/s produced a confidently reported
      // 2,977,758 "rps" for a run that completed 2,580.
      throughputRps: result.requests.average,
      bytesPerSecond: result.throughput.average,
      latencyMs: { p50: result.latency.p50, p99: result.latency.p99, max: result.latency.max },
      non2xx: result.non2xx,
      transportErrors: result.errors,
      failuresWithoutAnAnswer: clientFailures,
      failureRate: clientFailureRate,
      errorBreakdown,
    },
    server: {
      decisionsRecorded: decisionDelta,
      requestDelta,
      fivexxDelta,
      latencyMs: {
        p50: (serverPercentile(0.5) ?? 0) * 1000 === 0 ? null : Math.round(serverPercentile(0.5) * 1000),
        p95: serverPercentile(0.95) === null ? null : Math.round(serverPercentile(0.95) * 1000),
        p99: p99Ms,
      },
      note: 'Server percentiles come from the API histogram scraped before/after, so they exclude load-generator scheduling. They are cumulative since process start, which is why the deltas of the counters are reported alongside.',
    },
    queryPlans: plans,
    checks,
    verdict: checks.every((c) => c.pass && !c.unknown) ? 'PASS' : 'FAIL',
    environment: {
      node: process.version,
      runtimePoolMax: process.env.RUNTIME_POOL_MAX ?? '(default 10)',
      modelProvider: 'disabled (deterministic path)',
      rls: 'enforced for tenant traffic (see /health/ready tenant_isolation)',
    },
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(path.join(outDir, 'RESULTS.md'), renderMarkdown(report), 'utf8');

  console.log(`\nload test — ${report.verdict}`);
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail)}`);
  console.log(`\n  wrote ${path.relative(root, path.join(outDir, 'latest.json'))} and RESULTS.md`);
  if (report.verdict === 'FAIL') process.exitCode = 1;
}

function renderMarkdown(r) {
  const fmt = (v) => (v === null || v === undefined ? '—' : v);
  const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : fmt(v));
  return `# Load test — ${r.ranAt}

**Verdict: ${r.verdict}.** Target \`${r.target}\`, scenario \`${r.scenario}\`,
${r.workload.connections} concurrent clients for ${r.workload.durationSeconds}s against
\`${r.workload.path}\` with the model provider disabled (the deterministic path an
agent depends on when Meta is unreachable).

Reproduce with \`npm run load:test\`. This file is generated; do not hand-edit it.

## Result

| | value |
| --- | --- |
| Requests completed | ${fmt(r.client.requests)} (${fmt(r.client.throughputRps)} req/s) |
| Fresh policy decisions | ${fmt(r.pathMix.freshDecisions)} |
| Answered from the idempotent record | ${fmt(r.pathMix.replayedOrOther)} (${fmt((r.pathMix.replayShare ?? 0) * 100)}%) |
| Bytes/s on the wire | ${fmt(r.client.bytesPerSecond)} |
| Client latency p50 / p99 | ${fmt(r.client.latencyMs.p50)} ms / ${fmt(r.client.latencyMs.p99)} ms |
| Server decision p50 / p95 / p99 | ${fmt(r.server.latencyMs.p50)} / ${fmt(r.server.latencyMs.p95)} / ${fmt(r.server.latencyMs.p99)} ms |
| Decisions recorded | ${fmt(r.server.decisionsRecorded)} |
| HTTP status classes seen by the client | ${fmt(
    Object.entries(r.client.errorBreakdown.statusCodes)
      .map(([c, n]) => `${c}:${n}`)
      .join(' ') || 'none',
  )} |
| Requests with no usable answer | ${fmt(r.client.failuresWithoutAnAnswer)} (${pct(r.client.failureRate)}) — ${fmt(r.client.errorBreakdown.connectionErrorsAndTimeouts)} socket errors/timeouts, ${fmt(r.client.errorBreakdown.pipelineResets)} pipeline resets |

Client latency includes the load generator's own scheduling on the same host; the
server percentiles are the API's own histogram. Where the two disagree, the
generator is the reason, not the decision engine.

Availability is asserted twice on purpose. The server rate counts 5xx it actually
returned; the client rate counts requests that produced no usable answer at all.
A saturated pool shows up only in the second: the request is accepted, queued behind a
pooled transaction, and the generator gives up before the server has anything to
record. \`RUNTIME_POOL_MAX\` is therefore part of the workload description, not a
deployment detail — and \`npm run load:sweep\` measures what the ceiling actually is
rather than assuming the pool owns it.

${fmt(r.server.note)}

## Checks

${r.checks.map((c) => `- ${c.pass ? '✅' : '❌'} **${c.name}** — \`${JSON.stringify(c.detail)}\``).join('\n')}

## Query plans under load

\`EXPLAIN (ANALYZE, BUFFERS)\` for the four statements this path and its immediate
consumers depend on. Recorded so an index regression is visible as a plan change
rather than as a vague feeling that it got slower.

| statement | node | index | actual ms | rows |
| --- | --- | --- | --- | --- |
${Object.entries(r.queryPlans)
  .map(([label, p]) => {
    const plan = p;
    return `| ${label} | ${fmt(plan.node ?? 'error')} | ${fmt(plan.index)} | ${fmt(plan.actualMs)} | ${fmt(plan.rows)} |`;
  })
  .join('\n')}

## Reading the two rates

${r.pathMix.explanation}. autocannon replays its request list from the start on every
connection, so the ratio of fresh decisions to completed requests tracks the
connection count rather than the workload. The latency objective is evaluated on
the server's decision histogram, which only fresh decisions enter.

## What this does not measure

- Single host, single region, one Postgres. No failover timing, no cross-region
  write skew, no storage-level replication lag.
- Model provider disabled, so Meta's latency variance is excluded by construction.
  \`pz_model_latency_seconds\` carries it separately when a key is configured.
- A benchmark run is not a capacity claim for a deployment: connection ceilings,
  disk and the size of the approval queue all move the numbers. The thresholds
  asserted here are the SLOs, so a pass means "within objective on this rig".
`;
}

main().catch((err) => {
  console.error('load test crashed:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
