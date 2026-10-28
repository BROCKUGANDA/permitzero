#!/usr/bin/env node
/**
 * scripts/slo-report.mjs — measure the SLOs against a running stack.
 *
 * The README said "Performance SLOs are not measured under representative
 * load". A file of objectives is not a measurement, so this scrapes a live API's
 * /metrics, computes each objective's error rate and burn from the exposition,
 * and exits non-zero when one is breached.
 *
 * It holds itself to the same rule as scripts/verify.mjs: a signal that could not
 * be read is reported as NO_DATA, never as a pass. An SLO report that turns an
 * absent series into "zero violations" is worse than no report, because it is the
 * one artefact an operator would trust to say the system is healthy.
 *
 * `--strict` is the difference between "this report has nothing to say" and
 * "this report failed":
 *
 *   · without it, a run with no url, no token or an unreachable stack ends in
 *     SKIPPED and exit 0 — useful when the report is one step in a longer
 *     conversation, and only then;
 *   · with it, the same run ends in FAIL and exit 1, because the caller asked
 *     for a measurement and got nothing. A green run that proved nothing is the
 *     outcome this file exists to prevent, so strict mode refuses to produce
 *     one: an objective whose series is absent (NO_DATA), a stack that served
 *     no traffic at all (every rate would be a vacuous zero) and a report that
 *     measured nothing are all failures under `--strict`.
 *
 * One objective is deliberately outside that set. `permit-single-use` declares
 * itself `enforced-elsewhere`: its enforcement is a conditional UPDATE and a
 * unique constraint, asserted by named tests, and no scrape could ever produce
 * a signal for it. It is reported as NOT_SCRAPEABLE with the place its
 * enforcement lives, and it does not fail the strict gate — a gate that fails
 * for a signal it can never see is permanently red, and a permanently red gate
 * is one everybody learns to ignore.
 *
 * Usage:
 *   node scripts/slo-report.mjs --url http://127.0.0.1:8080 --token "$METRICS_TOKEN"
 *   ... --json     machine readable
 *   ... --strict   a report that measured nothing is a failure, not a skip
 */
import {
  SLOS,
  bucketCountAtOrBelow,
  errorBudget,
  errorRate,
  evaluateMultiWindow,
  histogramCount,
  parseExposition,
  sumBy,
} from '../packages/observability/src/index.js';

const argv = process.argv.slice(2);
const valueOf = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const baseUrl = valueOf('url', null);
const token = valueOf('token', process.env.METRICS_TOKEN ?? null);
const asJson = flag('json');
const strict = flag('strict');

async function scrape() {
  const res = await fetch(new URL('/metrics', baseUrl), { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

async function run() {
  const report = { url: baseUrl, scraped: false, measured: false, slos: [], notes: [], verdict: 'SKIPPED' };

  if (!baseUrl) {
    report.notes.push('no --url given, so there is no running stack to scrape');
    return finish(report);
  }
  if (!token) {
    report.notes.push('no --token (or METRICS_TOKEN): /metrics refuses an unauthenticated scrape by design');
    return finish(report);
  }

  let text;
  try {
    text = await scrape();
    report.scraped = true;
  } catch (err) {
    report.notes.push(`scrape failed: ${err instanceof Error ? err.message : String(err)}`);
    return finish(report);
  }

  const metrics = parseExposition(text);
  const totalRequests = sumBy(metrics, 'pz_http_requests_total') ?? 0;
  if (totalRequests === 0)
    report.notes.push('endpoint answered but has observed no traffic; every rate below is vacuous');

  for (const slo of SLOS) {
    if (slo.measuredBy.source === 'enforced-elsewhere') {
      report.slos.push({
        id: slo.id,
        name: slo.name,
        status: 'NOT_SCRAPEABLE',
        measured: false,
        // The objective is not missing a signal — it declares that it has none,
        // and names the place its enforcement actually lives.
        enforcedElsewhere: true,
        why: slo.measuredBy.where,
      });
      continue;
    }

    const samples = observe(metrics, slo);
    if (!samples) {
      report.slos.push({
        id: slo.id,
        name: slo.name,
        status: 'NO_DATA',
        measured: false,
        why: `series ${slo.measuredBy.metric} absent from the scrape`,
      });
      continue;
    }

    const alert = evaluateMultiWindow(slo, samples, samples);
    report.slos.push({
      id: slo.id,
      name: slo.name,
      kind: slo.kind,
      objective: slo.objective,
      budget: errorBudget(slo),
      total: samples.total,
      violated: samples.violated,
      observedErrorRate: Number(errorRate(samples).toFixed(6)),
      severity: alert.severity,
      firing: alert.firing,
      status: alert.firing ? 'BREACHED' : 'MET',
      reason: alert.reason,
      measured: true,
    });
  }

  const breached = report.slos.filter((s) => s.status === 'BREACHED');
  // An objective that declares itself enforced elsewhere is not an objective
  // this report failed to read: its signal lives in a database constraint and
  // the tests that assert it, and no scrape could ever produce one. Counting
  // it as unread would make `--strict` fail against a healthy stack for an
  // objective no measurement could ever satisfy, which is the same disease as a
  // permanently red gate — everybody learns to ignore it, and then it is not a
  // gate at all.
  const unread = report.slos.filter((s) => !s.measured && !s.enforcedElsewhere);
  const enforcedElsewhere = report.slos.filter((s) => s.enforcedElsewhere);
  if (enforcedElsewhere.length > 0) {
    report.notes.push(
      `not scrapeable, enforced elsewhere: ${enforcedElsewhere.map((s) => s.id).join(', ')} — the source of each objective is declared in packages/observability/src/slos.ts`,
    );
  }
  if (strict && unread.length > 0) {
    report.notes.push(
      `strict: ${unread.length} objective(s) could not be measured (${unread.map((u) => u.id).join(', ')})`,
    );
  }
  // Zero traffic is its own failure: every rate below would be zero over zero
  // events, which is the same vacuous arithmetic the note above warns about,
  // dressed up as a measurement.
  const failed = breached.length > 0 || (strict && unread.length > 0) || (strict && totalRequests === 0);
  return finish({ ...report, verdict: failed ? 'FAIL' : 'PASS' });
}

/** Turn one objective's declared series into {total, violated}. */
function observe(metrics, slo) {
  switch (slo.id) {
    case 'decision-availability': {
      const total = sumBy(metrics, 'pz_http_requests_total');
      if (total === null) return null;
      const bad = sumBy(metrics, 'pz_http_requests_total', { status_class: '5xx' }) ?? 0;
      return { total, violated: bad };
    }
    case 'decision-latency': {
      const count = histogramCount(metrics, 'pz_decision_duration_seconds');
      if (count === null || count === 0) return null;
      // Uses the bucket at exactly the threshold, which is why
      // DECISION_BUCKETS_SECONDS contains 1.5. Interpolating between 1 and 2.5
      // would be a guess presented as a measurement.
      const within = bucketCountAtOrBelow(metrics, 'pz_decision_duration_seconds', slo.thresholdMs / 1000);
      if (within === null) return null;
      return { total: count, violated: Math.max(0, count - within) };
    }
    case 'tenant-isolation': {
      const samples = metrics.get('pz_tenant_isolation_enforced')?.samples ?? [];
      if (samples.length === 0) return null;
      return { total: samples.length, violated: samples.filter((s) => s.value !== 1).length };
    }
    case 'audit-integrity': {
      const breaks = sumBy(metrics, 'pz_audit_chain_breaks');
      if (breaks === null) return null;
      return { total: 1, violated: breaks > 0 ? 1 : 0 };
    }
    case 'delivery-lag': {
      const age = metrics.get('pz_outbox_oldest_unpublished_age_seconds')?.samples?.[0]?.value;
      if (age === undefined) return null;
      return { total: 1, violated: age * 1000 > slo.thresholdMs ? 1 : 0 };
    }
    default:
      return null;
  }
}

/**
 * The verdict, the human-readable report, and the exit code that goes with it.
 *
 * The verdict is decided here, in one place, because it is the only thing this
 * file promises: a report that measured nothing has no verdict to offer, and
 * the difference between "nothing to say" (SKIPPED, exit 0) and "failed to
 * say it" (FAIL, exit 1) is `--strict`. Without it, `npm run slo:report:strict`
 * with no url printed SKIPPED and exited 0, which is a green run that proved
 * nothing — the exact failure mode the README's "objectives that can fail"
 * claim depends on not happening.
 */
function finish(report) {
  const measuredSomething = report.slos.some((s) => s.measured);
  report.measured = measuredSomething;

  if (report.verdict === 'PASS' && !measuredSomething) {
    // Nothing was measured, so nothing was passed. The report says so instead
    // of handing back a green tick it did not earn.
    report.verdict = 'SKIPPED';
    report.notes.push('nothing was measured: no objective could be read from this scrape');
  }
  if (report.verdict === 'SKIPPED' && strict) {
    report.verdict = 'FAIL';
    report.notes.push('strict: the report measured nothing, so it cannot report a pass');
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nPermitZero SLO report — ${report.url ?? '(no url)'} — ${report.verdict}`);
    console.log('─'.repeat(88));
    for (const s of report.slos) {
      const detail = s.measured
        ? `${(s.observedErrorRate ?? 0).toFixed(5)} error rate over ${s.total} events` +
          `${s.severity && s.severity !== 'none' ? `, ${s.severity}` : ''}`
        : s.why;
      console.log(`${String(s.status).padEnd(15)} ${s.id.padEnd(22)} ${detail}`);
    }
    for (const note of report.notes) console.log(`note: ${note}`);
    // Printed for the strict failure too: the verdict says the gate failed,
    // this line says why the failure is not a broken objective.
    if (!measuredSomething) console.log('\nNOT MEASURED — this is not a pass.');
  }
  if (report.verdict === 'FAIL') process.exitCode = 1;
  return report;
}

run().catch((err) => {
  console.error(`slo-report crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
