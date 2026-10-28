import { describe, expect, it } from 'vitest';
import { Registry } from 'prom-client';
import {
  DECISION_BUCKETS_SECONDS,
  SLOS,
  budgetConsumed,
  burnRate,
  burnRateForBudgetSpend,
  createMetrics,
  errorBudget,
  errorRate,
  evaluateMultiWindow,
  sloById,
  statusClass,
  type Samples,
  type SloDefinition,
} from '../src/index.js';

const availability: SloDefinition = {
  id: 'decision-availability',
  name: 'test availability',
  kind: 'availability',
  objective: 0.999,
  window: { windowDays: 30, shortWindowMinutes: 5, longWindowMinutes: 60 },
  page: true,
  description: 'fixture',
  measuredBy: { source: 'metrics', metric: 'pz_http_requests_total' },
};

const zeroTolerance: SloDefinition = {
  id: 'tenant-isolation',
  name: 'test zero tolerance',
  kind: 'zero-tolerance',
  objective: 1,
  window: { windowDays: 30, shortWindowMinutes: 5, longWindowMinutes: 60 },
  page: true,
  description: 'fixture',
  measuredBy: { source: 'metrics', metric: 'pz_tenant_isolation_enforced' },
};

const samples = (total: number, violated: number): Samples => ({ total, violated });

describe('error budget arithmetic', () => {
  it('the budget is the complement of the objective', () => {
    expect(errorBudget(availability)).toBeCloseTo(0.001, 12);
    expect(errorBudget(zeroTolerance)).toBe(0);
  });

  it('rejects an objective outside 0..1 instead of inventing a budget', () => {
    for (const objective of [1.5, -0.1, Number.NaN]) {
      expect(() => errorBudget({ ...availability, objective })).toThrow(RangeError);
    }
  });

  it('derives the familiar 14.4x page threshold rather than hardcoding it', () => {
    // 2% of a 30-day budget spent inside 1 hour. If this number drifts, every
    // alert rule in infra/prometheus is wrong too, so it is computed here.
    expect(burnRateForBudgetSpend(0.02, 30, 1)).toBeCloseTo(14.4, 10);
    expect(burnRateForBudgetSpend(0.05, 30, 6)).toBeCloseTo(6, 10);
    expect(burnRateForBudgetSpend(0.1, 30, 3)).toBeCloseTo(24, 10);
  });

  it('refuses a nonsensical spend or window', () => {
    expect(() => burnRateForBudgetSpend(1.5, 30, 1)).toThrow(RangeError);
    expect(() => burnRateForBudgetSpend(0.02, 30, 0)).toThrow(RangeError);
  });

  it('error rate of no traffic is zero, not NaN', () => {
    expect(errorRate(samples(0, 0))).toBe(0);
    // NaN would silently make every comparison false and every alert "not firing"
    // for an idle service — the quietest possible way to lose all alerting.
    expect(Number.isNaN(errorRate(samples(0, 0)))).toBe(false);
  });
});

describe('burn rate', () => {
  it('is 1.0 exactly on budget', () => {
    const onBudget = samples(100_000, 100); // 0.001 error rate, budget 0.001
    expect(burnRate(onBudget, availability)).toEqual({ kind: 'ratio', value: expect.closeTo(1, 9) });
  });

  it('scales with the observed error rate', () => {
    expect(burnRate(samples(1000, 15), availability)).toEqual({ kind: 'ratio', value: expect.closeTo(15, 9) });
  });

  it('distinguishes a zero-budget violation from a ratio', () => {
    const oneLeakInAMillion = samples(1_000_000, 1);
    expect(burnRate(oneLeakInAMillion, zeroTolerance)).toEqual({ kind: 'zero-tolerance-violated', violated: 1 });
    // The trap this avoids: as a ratio this is 0.0001% of a zero budget, i.e.
    // arithmetically fine, which is exactly the wrong conclusion for a leak.
    expect(budgetConsumed(oneLeakInAMillion, zeroTolerance, 1)).toBe(1);
  });

  it('reports a clean zero-tolerance window as zero burn', () => {
    expect(burnRate(samples(1000, 0), zeroTolerance)).toEqual({ kind: 'ratio', value: 0 });
  });

  it('calls an empty window no-traffic rather than perfect', () => {
    expect(burnRate(samples(0, 0), availability)).toEqual({ kind: 'no-traffic' });
    expect(budgetConsumed(samples(0, 0), availability, 1)).toBe(0);
  });
});

const pageLevel = samples(1000, 30); // 3% error rate = 30x burn

describe('multi-window evaluation', () => {
  it('pages only when BOTH windows exceed the threshold', () => {
    const alert = evaluateMultiWindow(availability, pageLevel, pageLevel);
    expect(alert.severity).toBe('page');
    expect(alert.firing).toBe(true);
    expect(alert.shortBurn).toBeGreaterThan(alert.threshold);
    expect(alert.longBurn).toBeGreaterThan(alert.threshold);
  });

  it('does NOT page on a short-window spike the long window disagrees with', () => {
    // The single-window rule this replaces pages on one bad scrape. This is the
    // test that keeps the multiwindow design honest; delete the long-window
    // condition and it fails.
    const spikeShort = samples(1000, 30);
    const calmLong = samples(100_000, 30); // same absolute failures, diluted over the hour
    const alert = evaluateMultiWindow(availability, spikeShort, calmLong);
    expect(alert.severity).not.toBe('page');
    expect(alert.firing).toBe(false);
  });

  it('flags a mild sustained burn as watch without firing', () => {
    // 0.3% error against a 0.1% budget is 3x burn: over budget, but below the
    // 6x ticket threshold. Firing here would be the boy-who-cried-wolf failure;
    // reporting 'none' would hide that the budget is draining.
    const mildLong = samples(10_000, 30);
    const cleanShort = samples(10_000, 0);
    const alert = evaluateMultiWindow(availability, cleanShort, mildLong);
    expect(alert.severity).toBe('watch');
    expect(alert.firing).toBe(false);
  });

  it('raises a ticket below the page threshold but above the ticket threshold', () => {
    // burn between 6x and 14.4x on both windows
    const burn = samples(100_000, 800); // 0.8% => 8x
    const alert = evaluateMultiWindow(availability, burn, burn);
    expect(alert.severity).toBe('ticket');
    expect(alert.firing).toBe(true);
  });

  it('marks over-budget-but-calm as watch and explicitly not firing', () => {
    const slight = samples(100_000, 150); // 0.15% => 1.5x, over budget, under ticket
    const alert = evaluateMultiWindow(availability, slight, slight);
    expect(alert.severity).toBe('watch');
    expect(alert.firing).toBe(false);
    expect(alert.longBurn).toBeGreaterThan(1);
  });

  it('reports within-budget as none', () => {
    const good = samples(100_000, 20); // 0.02% => 0.2x
    expect(evaluateMultiWindow(availability, good, good)).toMatchObject({ severity: 'none', firing: false });
  });

  it('pages immediately for a zero-budget violation and never for a clean one', () => {
    expect(evaluateMultiWindow(zeroTolerance, samples(1000, 0), samples(10_000, 1))).toMatchObject({
      severity: 'page',
      firing: true,
    });
    expect(evaluateMultiWindow(zeroTolerance, samples(1000, 0), samples(10_000, 0))).toMatchObject({
      severity: 'none',
      firing: false,
    });
  });

  it('routes a non-paging zero-budget violation to a ticket instead of silence', () => {
    const noPage: SloDefinition = { ...zeroTolerance, page: false };
    expect(evaluateMultiWindow(noPage, samples(100, 1), samples(100, 0)).severity).toBe('ticket');
  });
});

describe('the shipped SLO set', () => {
  it('every definition is internally consistent', () => {
    for (const slo of SLOS) {
      expect(slo.objective).toBeGreaterThan(0);
      expect(slo.objective).toBeLessThanOrEqual(1);
      expect(slo.window.longWindowMinutes).toBeGreaterThan(slo.window.shortWindowMinutes);
      expect(slo.window.windowDays).toBeGreaterThanOrEqual(slo.window.longWindowMinutes / 60 / 24);
      if (slo.kind === 'latency') expect(slo.thresholdMs).toBeGreaterThan(0);
      if (slo.kind === 'zero-tolerance') expect(slo.objective).toBe(1);
      // Every definition declares how it is observed; an SLO with no source is
      // prose, and prose cannot fail.
      expect(['metrics', 'enforced-elsewhere']).toContain(slo.measuredBy.source);
      if (slo.measuredBy.source === 'metrics') expect(slo.measuredBy.metric.length).toBeGreaterThan(0);
    }
  });

  it('the zero-tolerance objectives are the ones that must never average away', () => {
    const ids = SLOS.filter((s) => s.kind === 'zero-tolerance').map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['tenant-isolation', 'audit-integrity', 'permit-single-use']));
  });

  it('lookups find what exists and do not invent what does not', () => {
    expect(sloById('decision-availability')?.page).toBe(true);
    expect(sloById('does-not-exist')).toBeUndefined();
  });
});

describe('status classes', () => {
  it.each([
    [200, '2xx'],
    [201, '2xx'],
    [302, '3xx'],
    [404, '4xx'],
    [429, '4xx'],
    [500, '5xx'],
    [503, '5xx'],
    [100, 'other'],
  ])('%i maps to %s', (code, expected) => {
    expect(statusClass(code)).toBe(expected);
  });
});

describe('metrics registry', () => {
  it('exposes counters, histograms and their labels in Prometheus format', async () => {
    const metrics = createMetrics({ registry: new Registry(), processMetrics: false });
    metrics.decisions.inc({ decision: 'DENY', environment: 'DEMO', tool: 'payment.execute' });
    metrics.decisions.inc({ decision: 'ALLOW', environment: 'DEMO', tool: 'payment.execute' });
    metrics.decisionDuration.observe({ decision: 'DENY' }, 0.04);
    metrics.outboxByStatus.set({ status: 'PENDING' }, 7);
    metrics.tenantIsolationEnforced.set({ role: 'pz_app' }, 1);

    const text = await metrics.scrape();
    expect(text).toContain('pz_decisions_total');
    expect(text).toContain('decision="DENY"');
    expect(text).toContain('pz_decision_duration_seconds_bucket');
    expect(text).toContain('pz_outbox_events{status="PENDING"} 7');
    expect(text).toContain('pz_tenant_isolation_enforced{role="pz_app"} 1');
  });

  it('counts a decision exactly once per call', async () => {
    const metrics = createMetrics({ registry: new Registry(), processMetrics: false });
    for (let i = 0; i < 3; i++) {
      metrics.decisions.inc({ decision: 'ALLOW', environment: 'DEMO', tool: 'x' });
    }
    expect(await metrics.scrape()).toContain('pz_decisions_total{decision="ALLOW",environment="DEMO",tool="x"} 3');
  });

  it('keeps label combinations as separate series rather than merging them', async () => {
    const metrics = createMetrics({ registry: new Registry(), processMetrics: false });
    metrics.decisions.inc({ decision: 'ALLOW', environment: 'DEMO', tool: 'payment.execute' });
    metrics.decisions.inc({ decision: 'DENY', environment: 'DEMO', tool: 'payment.execute' });
    metrics.decisions.inc({ decision: 'ALLOW', environment: 'PRODUCTION', tool: 'payment.execute' });
    const text = await metrics.scrape();
    expect(text).toContain('decision="ALLOW",environment="DEMO"');
    expect(text).toContain('decision="DENY",environment="DEMO"');
    expect(text).toContain('decision="ALLOW",environment="PRODUCTION"');
  });

  it('applies const labels so one dashboard can separate deployments', async () => {
    const metrics = createMetrics({
      registry: new Registry(),
      processMetrics: false,
      constLabels: { service: 'permitzero-api', environment: 'staging' },
    });
    metrics.decisions.inc({ decision: 'DENY', environment: 'DEMO', tool: 'x' });
    const text = await metrics.scrape();
    expect(text).toContain('environment="staging"');
    expect(text).toContain('service="permitzero-api"');
  });

  it('keeps two registries independent', async () => {
    const a = createMetrics({ registry: new Registry(), processMetrics: false });
    const b = createMetrics({ registry: new Registry(), processMetrics: false });
    a.executions.inc({ outcome: 'SUCCEEDED' });
    expect(await b.scrape()).not.toContain('pz_executions_total{outcome="SUCCEEDED"} 1');
    expect(await a.scrape()).toContain('pz_executions_total{outcome="SUCCEEDED"} 1');
  });

  it('histogram buckets are ordered and cover the SLO threshold', async () => {
    // The threshold is read from the SLO rather than typed in, so moving the
    // objective without adding a bucket at the new boundary fails here instead
    // of quietly making the objective uncomputable from the exposition.
    const slo = sloById('decision-latency');
    const thresholdSeconds = (slo?.thresholdMs ?? 0) / 1000;
    expect(thresholdSeconds).toBeGreaterThan(0);

    const metrics = createMetrics({ registry: new Registry(), processMetrics: false });
    metrics.decisionDuration.observe({ decision: 'ALLOW' }, thresholdSeconds - 0.1);
    metrics.decisionDuration.observe({ decision: 'ALLOW' }, thresholdSeconds + 0.1);

    const text = await metrics.scrape();
    // 1.5s is the latency SLO threshold; a bucket straddling it is what makes
    // the objective computable from the exposition at all.
    expect(text).toContain(`le="${thresholdSeconds}"`);
    expect(text).toContain('pz_decision_duration_seconds_count');
    // The bucket at the threshold separates the two observations: one below it,
    // two at or below it. Read from the next bucket up, both of them would
    // count as compliant and the objective would be fiction.
    const bucketAt = (le: number): RegExp =>
      new RegExp(`pz_decision_duration_seconds_bucket\\{[^}]*le="${le}"[^}]*\\} \\d+`);
    expect(text).toMatch(bucketAt(thresholdSeconds));
    const thresholdCount = Number(/(\d+)\s*$/.exec(bucketAt(thresholdSeconds).exec(text)?.[0] ?? '')?.[1] ?? -1);
    expect(thresholdCount).toBe(1);
    const nextBucket = DECISION_BUCKETS_SECONDS.find((b) => b > thresholdSeconds);
    expect(nextBucket).toBeDefined();
    const nextCount = Number(/(\d+)\s*$/.exec(bucketAt(nextBucket as number).exec(text)?.[0] ?? '')?.[1] ?? -1);
    expect(nextCount).toBe(2);
    expect(text).toMatch(/pz_decision_duration_seconds_count\{[^}]*\} 2/);

    // The declared buckets are strictly increasing, so a bucket added out of
    // order cannot shadow the one the SLO reads.
    const declared = DECISION_BUCKETS_SECONDS;
    expect([...declared].sort((a, b) => a - b)).toEqual(declared);
    expect(declared).toContain(thresholdSeconds);
  });

  it('publishes the outbox row age and the queue job age as different series', async () => {
    // Two quantities that mean different things must not share a name. The row
    // age is the delivery-lag signal; the job age is the broker queue's own
    // backlog. A dispatcher that is wedged leaves the first growing and the
    // second at zero, which is exactly the situation a shared name hides.
    const metrics = createMetrics({ registry: new Registry(), processMetrics: false });
    metrics.outboxOldestAgeSeconds.set(42);
    metrics.outboxOldestJobAgeSeconds.set(0);
    const text = await metrics.scrape();
    expect(text).toContain('pz_outbox_oldest_unpublished_age_seconds 42');
    expect(text).toContain('pz_outbox_oldest_job_age_seconds 0');
  });
});
