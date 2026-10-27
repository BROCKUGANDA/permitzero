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
 * Usage:
 *   node scripts/slo-report.mjs --url http://127.0.0.1:8080 --token "$METRICS_TOKEN"
 *   ... --json     machine readable
 *   ... --strict   NO_DATA becomes a failure (what CI should use once there is traffic)
 */
import { SLOS, evaluateMultiWindow, errorBudget, errorRate } from '../packages/observability/src/index.js';

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

/**
 * Minimal Prometheus text parser: counters, gauges and histograms only.
 *
 * Not a dependency, because this is release evidence and it has to run in an
 * environment where installing a package may not be possible.
 */
function parseExposition(text) {
  /** @type {Map<string, {type: string, samples: Array<{labels: Record<string,string>, value: number}>}>} */
  const metrics = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const parts = line.split(/\s+/);
      if (parts[1] && parts[0] === '# TYPE') ensure(metrics, parts[1]).type = parts[2] ?? 'untyped';
      continue;
    }
    const braceStart = line.indexOf('{');
    let name;
    let labels = {};
    let valueText;
    if (braceStart === -1) {
      const parts = line.split(/\s+/);
      name = parts[0];
      valueText = parts[1];
    } else {
      name = line.slice(0, braceStart);
      const braceEnd = line.lastIndexOf('}');
      labels = parseLabels(line.slice(braceStart + 1, braceEnd));
      valueText = line.slice(braceEnd + 1).trim().split(/\s+/)[0];
    }
    const value = Number(valueText);
    if (!name || !Number.isFinite(value)) continue;
    ensure(metrics, name).samples.push({ labels, value });
  }
  return metrics;
}

function ensure(map, name) {
  if (!map.has(name)) map.set(name, { type: 'untyped', samples: [] });
  return map.get(name);
}

/** `k="v"` pairs; values may contain commas and escapes, so split outside quotes. */
function parseLabels(body) {
  const out = {};
  let key = '';
  let value = '';
  let mode = 'key';
  let escaped = false;
  for (const ch of body) {
    if (mode === 'key') {
      if (ch === '=') mode = 'value';
      else if (ch !== ' ' && ch !== ',') key += ch;
    } else if (mode === 'value') {
      if (escaped) {
        value += ch;
        escaped = false;
      } else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        out[key] = value;
        key = '';
        value = '';
        mode = 'between';
      } else value += ch;
    } else if (ch === ',') mode = 'key';
  }
  return out;
}

const matches = (labels, predicate) =>
  !predicate || Object.entries(predicate).every(([k, v]) => labels[k] === undefined || labels[k] === v);

function sumBy(metrics, name, predicate) {
  const entry = metrics.get(name);
  if (!entry) return null;
  return entry.samples.filter((s) => matches(s.labels, predicate)).reduce((acc, s) => acc + s.value, 0);
}

/** Count of observations at or below `le`, read from the bucket series. */
function bucketCountAtOrBelow(metrics, baseName, le, predicate) {
  const samples = (metrics.get(`${baseName}_bucket`)?.samples ?? []).filter((s) =>
    matches(s.labels, predicate),
  );
  if (samples.length === 0) return null;
  return samples.filter((s) => s.labels.le !== '+Inf' && Number(s.labels.le) <= le).reduce((a, s) => a + s.value, 0);
}

async function scrape() {
  const res = await fetch(new URL('/metrics', baseUrl), { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

async function run() {
  const report = { url: baseUrl, scraped: false, slos: [], notes: [], verdict: 'SKIPPED' };

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
  if (totalRequests === 0) report.notes.push('endpoint answered but has observed no traffic; every rate below is vacuous');

  for (const slo of SLOS) {
    if (slo.measuredBy.source === 'enforced-elsewhere') {
      report.slos.push({
        id: slo.id,
        name: slo.name,
        status: 'NOT_SCRAPEABLE',
        measured: false,
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
  const unread = report.slos.filter((s) => !s.measured);
  if (strict && unread.length > 0) {
    report.notes.push(`strict: ${unread.length} objective(s) could not be measured (${unread.map((u) => u.id).join(', ')})`);
  }
  const failed = breached.length > 0 || (strict && unread.length > 0);
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
      const count = sumBy(metrics, 'pz_decision_duration_seconds_count');
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

function finish(report) {
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
    if (report.verdict === 'SKIPPED') console.log('\nNOT MEASURED — this is not a pass.');
  }
  if (report.verdict === 'FAIL') process.exitCode = 1;
  return report;
}

run().catch((err) => {
  console.error(`slo-report crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
