/**
 * Service-level objectives, and the arithmetic that decides whether one is
 * being met.
 *
 * An SLO is not a target written in a document; it is a formula applied to a
 * signal. The reason this file exists as code rather than prose is that prose
 * cannot be wrong in a checkable way — this can, and its tests are written to
 * be capable of failing.
 *
 * The definitions here are deliberately modest and every one of them is
 * measured by something in this repository (see `scripts/slo-report.mjs`),
 * because an objective nobody measures is theatre.
 */

/** Fraction of requests/events allowed to fail before the budget is gone. */
export interface SloWindow {
  /** How much history the objective is stated over, in days. */
  windowDays: number;
  /** Short evaluation window, in minutes, for the fast-burn signal. */
  shortWindowMinutes: number;
  /** Long evaluation window, in minutes, that must agree before paging. */
  longWindowMinutes: number;
}

export type SloKind = 'availability' | 'latency' | 'zero-tolerance';

export interface SloDefinition {
  id: string;
  name: string;
  kind: SloKind;
  /**
   * Target proportion of compliant events, e.g. 0.999. For `zero-tolerance`
   * this is 1 exactly: there is no budget, so a single violation is the alert.
   */
  objective: number;
  window: SloWindow;
  /** Latency objectives only: the threshold a request must stay under. */
  thresholdMs?: number;
  /** What the operator does when this fires. */
  page: boolean;
  description: string;
  /**
   * How this objective is actually observed. Not documentation flavour: an SLO
   * with no source gets reported as NOT MEASURED, whereas silently defaulting to
   * "zero violations observed" would make an unmeasured objective look like a
   * passing one — which is the single most damaging thing an SLO report can do.
   */
  measuredBy:
    | { source: 'metrics'; metric: string }
    /** Enforced by the database or by a test rather than by a scraped signal. */
    | { source: 'enforced-elsewhere'; where: string };
  /** Prometheus label value that counts as a violation for a metric-sourced SLO. */
  violationLabels?: Record<string, string>;
}

/** Events counted, and how many of them violated the objective. */
export interface Samples {
  total: number;
  violated: number;
}

/** The budget: the share of events that may violate the objective. */
export function errorBudget(definition: SloDefinition): number {
  // NaN passes a `< 0 || > 1` test because every comparison with NaN is false,
  // and would then propagate a NaN budget into every burn rate and every alert
  // comparison — all of which are false against NaN, so the service would report
  // "within budget" forever. An unparseable objective must fail loudly.
  if (!Number.isFinite(definition.objective) || definition.objective < 0 || definition.objective > 1) {
    throw new RangeError(`SLO ${definition.id}: objective must be within 0..1, got ${definition.objective}`);
  }
  return 1 - definition.objective;
}

export function errorRate(samples: Samples): number {
  if (samples.total === 0) return 0;
  return samples.violated / samples.total;
}

/**
 * How many times faster than allowed we are burning the budget.
 *
 * A burn rate of 1 means exactly on budget. 14.4 means the 30-day budget is
 * being consumed 14.4 times over — which empties it in about two days.
 *
 * `zero-tolerance` objectives have a budget of 0, so the ratio is undefined
 * rather than infinite: any violation is the alert and no amount of clean
 * traffic dilutes it. Collapsing that case to `Infinity` would make every
 * subsequent comparison true, including "budget consumed", which would then
 * claim the whole budget was spent by one event out of a million.
 */
export type BurnRate =
  { kind: 'ratio'; value: number } | { kind: 'zero-tolerance-violated'; violated: number } | { kind: 'no-traffic' };

export function burnRate(samples: Samples, definition: SloDefinition): BurnRate {
  const budget = errorBudget(definition);
  if (samples.total === 0) return { kind: 'no-traffic' };
  if (budget === 0) {
    return samples.violated > 0
      ? { kind: 'zero-tolerance-violated', violated: samples.violated }
      : { kind: 'ratio', value: 0 };
  }
  return { kind: 'ratio', value: errorRate(samples) / budget };
}

/**
 * The burn rate that consumes `budgetSpend` of the total budget within
 * `alertWindowHours`, for an objective stated over `windowDays`.
 *
 * Derivation, so the familiar 14.4x / 6x / 3x / 1x numbers are computed here
 * rather than copied from a blog post:
 *
 *   budget_consumed = burn_rate x (T / (W x 24))
 *   solve for burn_rate at budget_consumed = spend
 *   burn_rate = spend x (W x 24) / T
 *
 * With a 30-day budget, spending 2% of it in 1 hour needs a burn rate of
 * 0.02 x 720 = 14.4. That is the page threshold below, and it falls out of the
 * arithmetic instead of being asserted.
 */
export function burnRateForBudgetSpend(budgetSpend: number, windowDays: number, alertWindowHours: number): number {
  if (alertWindowHours <= 0) throw new RangeError('alertWindowHours must be positive');
  if (budgetSpend < 0 || budgetSpend > 1) throw new RangeError('budgetSpend must be within 0..1');
  return (budgetSpend * windowDays * 24) / alertWindowHours;
}

/** Fraction of the objective's budget consumed over the stated window. */
export function budgetConsumed(samples: Samples, definition: SloDefinition, elapsedHours: number): number {
  const rate = burnRate(samples, definition);
  if (rate.kind === 'no-traffic') return 0;
  if (rate.kind === 'zero-tolerance-violated') return 1;
  return rate.value * (elapsedHours / (definition.window.windowDays * 24));
}

export interface MultiWindowAlert {
  severity: 'page' | 'ticket' | 'watch' | 'none';
  /** True only when BOTH windows exceed the threshold — the multiwindow rule. */
  firing: boolean;
  shortBurn: number;
  longBurn: number;
  threshold: number;
  reason: string;
}

/**
 * Google SRE multi-window, multi-burn-rate evaluation.
 *
 * The long window carries the signal (a sustained burn really is consuming
 * budget); the short window suppresses the false positive you would otherwise
 * get from one stale scrape or a brief retry storm that self-heals. Requiring
 * both is the whole point — a single-window rule pages on noise.
 */
export function evaluateMultiWindow(
  definition: SloDefinition,
  shortWindow: Samples,
  longWindow: Samples,
): MultiWindowAlert {
  const budget = errorBudget(definition);
  const longHours = definition.window.longWindowMinutes / 60;
  // Page: 2% of the budget spent in the long window. Ticket: 5% of the budget
  // spent over six times as long — the slower signal that means "you are
  // trending at the edge of your budget" rather than "start the incident".
  //
  // Both were previously computed over `longHours`, which inverted their
  // severity: 5% in one hour is a HIGHER burn rate (36x) than 2% in one hour
  // (14.4x), so the "ticket" rule only ever fired on calls the page rule had
  // already accepted, and the ticket tier silently never existed. The threshold
  // arithmetic is asserted in the tests rather than trusted.
  const pageThreshold = burnRateForBudgetSpend(0.02, definition.window.windowDays, longHours);
  const ticketThreshold = burnRateForBudgetSpend(0.05, definition.window.windowDays, longHours * 6);

  const short = burnRate(shortWindow, definition);
  const long = burnRate(longWindow, definition);

  if (budget === 0) {
    const violated =
      (long.kind === 'zero-tolerance-violated' ? long.violated : 0) +
      (short.kind === 'zero-tolerance-violated' ? short.violated : 0);
    return {
      severity: violated > 0 ? (definition.page ? 'page' : 'ticket') : 'none',
      firing: violated > 0,
      shortBurn: short.kind === 'ratio' ? short.value : violated > 0 ? Infinity : 0,
      longBurn: long.kind === 'ratio' ? long.value : violated > 0 ? Infinity : 0,
      threshold: 0,
      reason:
        violated > 0
          ? `${violated} violation(s) against a zero-budget objective — there is no allowance to consume`
          : 'no violations against a zero-budget objective',
    };
  }

  const shortBurn = short.kind === 'ratio' ? short.value : 0;
  const longBurn = long.kind === 'ratio' ? long.value : 0;

  const pageFires = shortBurn > pageThreshold && longBurn > pageThreshold;
  const ticketFires = shortBurn > ticketThreshold && longBurn > ticketThreshold;

  if (pageFires && definition.page) {
    return {
      severity: 'page',
      firing: true,
      shortBurn,
      longBurn,
      threshold: pageThreshold,
      reason: `burning ${shortBurn.toFixed(1)}x (short) and ${longBurn.toFixed(1)}x (long) the allowed error rate; threshold ${pageThreshold.toFixed(1)}x`,
    };
  }
  if (ticketFires) {
    return {
      severity: 'ticket',
      firing: true,
      shortBurn,
      longBurn,
      threshold: ticketThreshold,
      reason: `burning ${shortBurn.toFixed(1)}x (short) and ${longBurn.toFixed(1)}x (long); threshold ${ticketThreshold.toFixed(1)}x`,
    };
  }
  if (longBurn > 1) {
    return {
      severity: 'watch',
      firing: false,
      shortBurn,
      longBurn,
      threshold: ticketThreshold,
      reason: `over budget (${longBurn.toFixed(2)}x) but below any alerting threshold`,
    };
  }
  return { severity: 'none', firing: false, shortBurn, longBurn, threshold: ticketThreshold, reason: 'within budget' };
}

/**
 * The objectives this product claims. Each names the signal it is computed
 * from, so the claim can be checked rather than trusted.
 */
export const SLOS: readonly SloDefinition[] = [
  {
    id: 'decision-availability',
    name: 'Authorization decisions are answered',
    kind: 'availability',
    objective: 0.999,
    window: { windowDays: 30, shortWindowMinutes: 5, longWindowMinutes: 60 },
    page: true,
    description:
      'Share of POST /v1/actions calls that are not answered with a 5xx or a connection failure. A denied action is availability success; a 500 is not.',
    measuredBy: { source: 'metrics', metric: 'pz_http_requests_total' },
    violationLabels: { status_class: '5xx' },
  },
  {
    id: 'decision-latency',
    name: 'Decisions complete within 1.5s at p99',
    kind: 'latency',
    objective: 0.99,
    thresholdMs: 1500,
    window: { windowDays: 28, shortWindowMinutes: 5, longWindowMinutes: 60 },
    page: false,
    description:
      'Measured with the model provider disabled, which is the deterministic path an agent depends on. Model latency is reported separately because its variance belongs to the provider, not to the decision engine.',
    measuredBy: { source: 'metrics', metric: 'pz_decision_duration_seconds' },
  },
  {
    id: 'tenant-isolation',
    name: 'No cross-tenant data read',
    kind: 'zero-tolerance',
    objective: 1,
    window: { windowDays: 30, shortWindowMinutes: 5, longWindowMinutes: 60 },
    page: true,
    description:
      "Any detected read of one tenant's row by another tenant's context pages immediately and stops protected writes. There is no budget for this and no averaging that can dilute it.",
    measuredBy: { source: 'metrics', metric: 'pz_tenant_isolation_enforced' },
  },
  {
    id: 'audit-integrity',
    name: 'The audit hash chain verifies',
    kind: 'zero-tolerance',
    objective: 1,
    window: { windowDays: 30, shortWindowMinutes: 5, longWindowMinutes: 60 },
    page: true,
    description:
      'pz_audit_chain_breaks > 0 for any tenant. The chain is the evidence product; a broken chain is not a degraded service, it is a failed one.',
    measuredBy: { source: 'metrics', metric: 'pz_audit_chain_breaks' },
  },
  {
    id: 'permit-single-use',
    name: 'Permits are spent at most once',
    kind: 'zero-tolerance',
    objective: 1,
    window: { windowDays: 30, shortWindowMinutes: 5, longWindowMinutes: 60 },
    page: true,
    description:
      'Two accepted executions from one permit token. Enforced by a conditional UPDATE and a database unique constraint, so a violation here means both failed.',
    measuredBy: {
      source: 'enforced-elsewhere',
      where:
        'consumePermit()s conditional UPDATE plus uq_permits_nonce, asserted by packages/broker/test/permits.test.ts and packages/db/test/execution-stores.test.ts. There is no scrape signal for a double spend that both guards allowed, so none is claimed.',
    },
  },
  {
    id: 'delivery-lag',
    name: 'Outbox events reach the queue within 60s at p95',
    kind: 'latency',
    objective: 0.99,
    thresholdMs: 60_000,
    window: { windowDays: 30, shortWindowMinutes: 5, longWindowMinutes: 60 },
    page: false,
    description:
      "Age of the oldest outbox row that has not been published yet, measured in the database rather than in the queue: a wedged dispatcher leaves unpublished rows behind and an empty queue, so the queue's own age would read zero while delivery is hours late. Side effects are dispatched by the worker, so a growing lag delays execution without changing any decision. Dead-lettered rows are excluded — they are a delivery failure with their own signal, not a delivery that is still late.",
    measuredBy: { source: 'metrics', metric: 'pz_outbox_oldest_unpublished_age_seconds' },
  },
] as const;

export function sloById(id: string): SloDefinition | undefined {
  return SLOS.find((s) => s.id === id);
}
