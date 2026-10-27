/**
 * The alert rules and the SLO code must not be allowed to drift apart.
 *
 * `infra/observability/prometheus/rules/permitzero-alerts.yml` is a hand-written
 * file containing numbers that `packages/observability/src/slos.ts` computes.
 * Nothing else connects them, so this file is the connection: it reads the rules
 * text and asserts every burn-rate multiplier is the one the formula produces,
 * and that every objective with a scrapeable signal actually has an alert.
 *
 * The second direction matters more than the first. A threshold that drifts makes
 * an alert noisy or late; an objective with no alert at all makes the SLO
 * document a claim about behaviour nobody is watching for.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SLOS, burnRateForBudgetSpend, errorBudget } from '../src/index.js';

const RULES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../infra/observability/prometheus/rules/permitzero-alerts.yml',
);
const rules = readFileSync(RULES_PATH, 'utf8');

/** `> (14.4 * 0.001)` — the pair the rules file uses everywhere. */
const BURN_PAIR = />\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*\*\s*(0\.0+[0-9]*[1-9])\s*\)/g;

const alerts = (() => {
  const blocks: Array<{ name: string; body: string; slo?: string; severity?: string }> = [];
  const lines = rules.split('\n');
  let current: { name: string; lines: string[] } | null = null;
  for (const line of lines) {
    const started = /^\s{6}- alert: (\S+)/.exec(line);
    if (started) {
      if (current) blocks.push(finish(current));
      current = { name: started[1] as string, lines: [] };
      continue;
    }
    if (current && /^\s{6}- /.test(line)) {
      blocks.push(finish(current));
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(finish(current));
  return blocks;
})();

function finish(block: { name: string; lines: string[] }) {
  const body = block.lines.join('\n');
  return {
    name: block.name,
    body,
    slo: /slo:\s*(\S+)/.exec(body)?.[1],
    severity: /severity:\s*(\S+)/.exec(body)?.[1],
  };
}

describe('alert rules exist for every measurable objective', () => {
  it('parses the rules file into alert blocks', () => {
    expect(alerts.length).toBeGreaterThanOrEqual(7);
  });

  it.each(SLOS.filter((s) => s.measuredBy.source === 'metrics').map((s) => [s.id, s.measuredBy] as const))(
    '%s has an alert that reads its declared signal',
    (sloId, measuredBy) => {
      const withSlo = alerts.filter((a) => a.slo === sloId);
      expect(withSlo.length, `no alert labelled slo=${sloId}`).toBeGreaterThan(0);
      if (measuredBy.source !== 'metrics') return;
      const metric = measuredBy.metric;
      const readsMetric = withSlo.some((a) => a.body.includes(metric));
      expect(readsMetric, `alerts for ${sloId} never mention ${metric}`).toBe(true);
    },
  );

  it('names each alert objective in the SLO set, with no orphan labels', () => {
    const ids = new Set(SLOS.map((s) => s.id));
    for (const alert of alerts) {
      if (!alert.slo) continue;
      expect(ids.has(alert.slo), `${alert.name} references unknown slo=${alert.slo}`).toBe(true);
    }
  });
});

describe('burn-rate thresholds agree with the arithmetic that derives them', () => {
  /**
   * (alert, spend, windowDays, alertWindowHours) — the pairs the rules file is
   * supposed to contain. `alertWindowHours` is the LONG range window used in the
   * expression, which is what the formula divides by.
   */
  const expectations: Array<[string, number, number, number]> = [
    ['PermitZeroDecisionAvailabilityFastBurn', 0.02, 30, 1],
    ['PermitZeroDecisionAvailabilitySlowBurn', 0.05, 30, 6],
    ['PermitZeroDecisionLatencyBurn', 0.02, 28, 1],
  ];

  it.each(expectations)('%s threshold equals spend x (days x 24) / hours', (name, spend, days, hours) => {
    const alert = alerts.find((a) => a.name === name);
    expect(alert, `${name} is missing from the rules file`).toBeDefined();
    const pairs = [...(alert as { body: string }).body.matchAll(BURN_PAIR)];
    expect(pairs.length, `${name} has no > (burn * budget) comparison`).toBeGreaterThan(0);

    const expectedBurn = burnRateForBudgetSpend(spend, days, hours);
    const slo = SLOS.find((s) => s.id === alert?.slo);
    expect(slo, `${name} is not labelled with a known slo`).toBeDefined();

    for (const [, burnText, budgetText] of pairs) {
      const observedBurn = Number(burnText);
      const observedBudget = Number(budgetText);
      // The budget side must be the objective's own complement — a rule that
      // multiplied by a hand-typed budget would silently retarget the objective.
      expect(observedBudget, `${name} multiplies a budget that is not its SLO's`).toBeCloseTo(
        errorBudget(slo as (typeof SLOS)[number]),
        12,
      );
      expect(observedBurn, `${name} burn multiplier`).toBeCloseTo(expectedBurn, 6);
    }
  });

  it('keeps the fast-burn multiplier above the slow-burn one, as severity requires', () => {
    const fast = alerts.find((a) => a.name === 'PermitZeroDecisionAvailabilityFastBurn');
    const slow = alerts.find((a) => a.name === 'PermitZeroDecisionAvailabilitySlowBurn');
    const first = (b: string) => Number([...b.matchAll(BURN_PAIR)][0]?.[1] ?? 0);
    expect(first(fast!.body)).toBeGreaterThan(first(slow!.body));
  });

  it('never expresses a zero-tolerance objective as a rate', () => {
    for (const id of ['tenant-isolation', 'audit-integrity']) {
      const forId = alerts.filter((a) => a.slo === id);
      expect(forId.length).toBeGreaterThan(0);
      for (const alert of forId) {
        expect(alert.body, `${alert.name} divides by a volume, which would average a leak away`).not.toMatch(
          /\/\s*sum\(/,
        );
        expect(alert.body).not.toMatch(BURN_PAIR);
      }
    }
  });

  it('pages on the zero-budget objectives rather than filing a ticket', () => {
    for (const id of ['tenant-isolation', 'audit-integrity']) {
      expect(
        alerts.filter((a) => a.slo === id).every((a) => a.severity === 'page'),
        id,
      ).toBe(true);
    }
  });

  it('requires both windows on every multi-window rule', () => {
    // Each availability/latency rule is an `and` of a long range and a short
    // range; a single-window rule pages on one bad scrape.
    for (const name of ['PermitZeroDecisionAvailabilityFastBurn', 'PermitZeroDecisionLatencyBurn']) {
      const body = alerts.find((a) => a.name === name)!.body;
      expect(body).toContain('\n          and\n');
      const ranges = [...body.matchAll(/\[(\d+m|1h|6h)\]/g)].map((m) => m[1]);
      expect(new Set(ranges).size).toBeGreaterThanOrEqual(2);
    }
  });
});
