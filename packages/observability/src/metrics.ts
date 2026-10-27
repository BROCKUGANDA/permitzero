/**
 * The metric set an authorization plane is actually accountable for.
 *
 * Deliberately not a generic HTTP dashboard. What matters here is whether a
 * decision was made, how long the caller waited for it, whether the model
 * contributed or was absent, whether permits behaved as single-use, whether
 * delivery is keeping up, and whether the tenant boundary held. Every one of
 * those is a number a reviewer can ask for and this process can produce.
 *
 * Cardinality is bounded on purpose: the HTTP labels use the Fastify *route
 * pattern* (`/v1/actions/:id/execute`), never the concrete URL. Binding a label
 * to an action id would create unbounded time series — one per action ever
 * submitted — which is the standard way to turn a monitoring feature into a
 * denial of service against your own metrics backend.
 *
 * One registry per app instance, not a module-global. `createMetrics()` accepts
 * an existing registry so a test can assert on exactly the series it produced,
 * and so two processes in one test run cannot read each other's counters.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Latency buckets for a decision: 10ms fast path up to a 10s pathological one.
 *
 * 1.5 is there because it is the `decision-latency` SLO threshold. Prometheus
 * histograms can only count what lands in a bucket, so without a bucket exactly
 * at the boundary the objective is not computable from the exposition: the 1s
 * bucket under-counts and the 2.5s bucket over-counts, and whichever way the
 * error rate is then computed, it is fiction. Any future threshold change must
 * add its own bucket or the SLO stops being measurable.
 */
export const DECISION_BUCKETS_SECONDS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2.5, 5, 10];

/** Delivery lag buckets for outbox → queue, in seconds. */
export const DELIVERY_BUCKETS_SECONDS = [0.25, 1, 5, 15, 30, 60, 300, 900];

export interface MetricsBundle {
  registry: Registry;
  /** Requests answered, by route pattern, method and status class. */
  httpRequests: Counter<'route' | 'method' | 'status_class'>;
  /** Wall time per request, by route pattern and method. */
  httpDuration: Histogram<'route' | 'method'>;
  /** The product's core output: what was decided. */
  decisions: Counter<'decision' | 'environment' | 'tool'>;
  /** How long the caller waited for a decision, including any model screening. */
  decisionDuration: Histogram<'decision'>;
  /** Deterministic policy evaluations, so engine volume is separable from model volume. */
  policyEvaluations: Counter<'decision' | 'model_signal_used'>;
  /** Model screening outcomes — the advisory path, never an authority. */
  modelScreenings: Counter<'status' | 'error_class'>;
  modelLatency: Histogram;
  /** Permits issued, and every reason a presented permit was refused. */
  permitsIssued: Counter<'outcome'>;
  permitRejections: Counter<'reason'>;
  /** Broker outcomes, including the ones that must be reconciled. */
  executions: Counter<'outcome'>;
  /**
   * Human approval decisions, kept separate from `decisions` (which counts the
   * policy engine). Mixing them makes a rise in approvals look like a rise in
   * automated denials, and the two have opposite operational meanings.
   */
  approvalDecisions: Counter<'decision' | 'quorum_complete'>;
  /** Outbox backlog by state; the gauge behind the delivery-lag SLO. */
  outboxByStatus: Gauge<'status'>;
  /** Age of the oldest unpublished outbox row, in seconds. */
  outboxOldestAgeSeconds: Gauge;
  /** 1 when the serving role is bound by row-level security and fully covered. */
  tenantIsolationEnforced: Gauge<'role'>;
  /** Audit chain verification result for the tenant last checked. 0 = valid. */
  auditChainBreaks: Gauge;
  /** Circuit-breaker state per dependency: 0 closed, 1 half-open, 2 open. */
  breakerState: Gauge<'dependency'>;
  /** Renders the Prometheus text exposition. */
  scrape(): Promise<string>;
}

export interface CreateMetricsOptions {
  registry?: Registry;
  /** Attached to every series; lets one dashboard separate staging from production. */
  constLabels?: Record<string, string>;
  /** Opt out of process/cpu/GC series — tests do, so their output stays readable. */
  processMetrics?: boolean;
}

export function createMetrics(opts: CreateMetricsOptions = {}): MetricsBundle {
  const registry = opts.registry ?? new Registry();
  // Deployment identity is set on the registry, not per metric.
  //
  // `constLabels` on a Counter/Gauge/Histogram looks exactly like the right
  // option and is silently ignored by prom-client 15 — measured, not assumed:
  // a counter declared with constLabels scrapes without them. So the labels
  // this file claims to attach would simply not have been there, and a dashboard
  // querying by `service="permitzero-api"` would have found nothing while every
  // unit test still passed, because nothing asserted the exposition rather than
  // the option object.
  if (opts.constLabels) registry.setDefaultLabels(opts.constLabels);
  if (opts.processMetrics !== false && !processMetricsRegistered(registry)) {
    collectDefaultMetrics({
      register: registry,
      prefix: 'pz_process_',
    });
  }

  const httpRequests = new Counter({
    name: 'pz_http_requests_total',
    help: 'Requests answered, labelled by route pattern, method and status class.',
    labelNames: ['route', 'method', 'status_class'],
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: 'pz_http_request_duration_seconds',
    help: 'End-to-end request latency by route pattern and method.',
    labelNames: ['route', 'method'],
    buckets: DECISION_BUCKETS_SECONDS,
    registers: [registry],
  });

  const decisions = new Counter({
    name: 'pz_decisions_total',
    help: 'Authorization decisions made, by outcome, environment and tool.',
    labelNames: ['decision', 'environment', 'tool'],
    registers: [registry],
  });

  const decisionDuration = new Histogram({
    name: 'pz_decision_duration_seconds',
    help: 'Time from intake to a durable decision, by outcome.',
    labelNames: ['decision'],
    buckets: DECISION_BUCKETS_SECONDS,
    registers: [registry],
  });

  const policyEvaluations = new Counter({
    name: 'pz_policy_evaluations_total',
    help: 'Deterministic policy evaluations. model_signal_used separates the advisory path from the engine alone.',
    labelNames: ['decision', 'model_signal_used'],
    registers: [registry],
  });

  const modelScreenings = new Counter({
    name: 'pz_model_screenings_total',
    help: 'Meta Model API screening attempts by outcome. A rise in status=error is a degradation of advice, never of authority.',
    labelNames: ['status', 'error_class'],
    registers: [registry],
  });

  const modelLatency = new Histogram({
    name: 'pz_model_latency_seconds',
    help: 'Model provider round-trip latency, including retries.',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });

  const permitsIssued = new Counter({
    name: 'pz_permits_total',
    help: 'Permits issued or refused at spend time.',
    labelNames: ['outcome'],
    registers: [registry],
  });

  const permitRejections = new Counter({
    name: 'pz_permit_rejections_total',
    help: 'Permit presentation refusals by reason code. PERMIT_CONSUMED rising means a client is retrying with a spent token.',
    labelNames: ['reason'],
    registers: [registry],
  });

  const approvalDecisions = new Counter({
    name: 'pz_approval_decisions_total',
    help: 'Human approval decisions. quorum_complete=false means the action is still waiting for another approver.',
    labelNames: ['decision', 'quorum_complete'],
    registers: [registry],
  });

  const executions = new Counter({
    name: 'pz_executions_total',
    help: 'Broker outcomes. UNKNOWN_OUTCOME is the reconciliation trigger, not a failure to hide.',
    labelNames: ['outcome'],
    registers: [registry],
  });

  const outboxByStatus = new Gauge({
    name: 'pz_outbox_events',
    help: 'Outbox rows by state. A rising FAILED/DEAD count is a delivery incident.',
    labelNames: ['status'],
    registers: [registry],
  });

  const outboxOldestAgeSeconds = new Gauge({
    name: 'pz_outbox_oldest_unpublished_age_seconds',
    help: 'Age of the oldest row still waiting to be published — the delivery-lag signal.',
    registers: [registry],
  });

  const tenantIsolationEnforced = new Gauge({
    name: 'pz_tenant_isolation_enforced',
    help: '1 when the serving role is bound by row-level security with full table coverage. 0 means the database is not enforcing tenant isolation for this process.',
    labelNames: ['role'],
    registers: [registry],
  });

  const auditChainBreaks = new Gauge({
    name: 'pz_audit_chain_breaks',
    help: 'Breaks found by the most recent audit chain verification. Any non-zero value is an integrity incident.',
    registers: [registry],
  });

  const breakerState = new Gauge({
    name: 'pz_circuit_breaker_state',
    help: 'Circuit breaker state per dependency: 0 closed, 1 half-open, 2 open.',
    labelNames: ['dependency'],
    registers: [registry],
  });

  return {
    registry,
    httpRequests,
    httpDuration,
    decisions,
    decisionDuration,
    policyEvaluations,
    modelScreenings,
    modelLatency,
    permitsIssued,
    permitRejections,
    executions,
    approvalDecisions,
    outboxByStatus,
    outboxOldestAgeSeconds,
    tenantIsolationEnforced,
    auditChainBreaks,
    breakerState,
    scrape: () => registry.metrics(),
  };
}

function processMetricsRegistered(registry: Registry): boolean {
  // Calling collectDefaultMetrics twice on one registry re-registers event-loop
  // collectors and duplicates nodejs_eventloop_lag samples per scrape.
  return registry.getSingleMetric('pz_process_cpu_user_seconds_total') !== undefined;
}

/**
 * Status class rather than status code: `201` and `200` are the same thing to an
 * SLO, while `429` and `503` are not. Keeps five series where there would be
 * sixty, and makes alert rules read as intent.
 */
export function statusClass(statusCode: number): '2xx' | '3xx' | '4xx' | '5xx' | 'other' {
  if (statusCode >= 200 && statusCode < 300) return '2xx';
  if (statusCode >= 300 && statusCode < 400) return '3xx';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  if (statusCode >= 500) return '5xx';
  return 'other';
}
