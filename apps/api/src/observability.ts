/**
 * Fastify wiring for the observability package: request metrics, W3C trace
 * correlation, and the scrape endpoint.
 *
 * Kept out of `packages/observability` so that package stays free of a web
 * framework and the worker can emit the same series.
 *
 * Two decisions worth defending:
 *
 * · Labels use the Fastify route *pattern*, never the concrete URL. Binding a
 *   label to `/v1/actions/act_01H...` creates one time series per action ever
 *   submitted, which is a self-inflicted denial of service on the metrics
 *   backend rather than monitoring.
 * · The trace id is derived from an incoming `traceparent` when it parses, and
 *   generated when it does not. A malformed header is discarded, not repaired:
 *   an untrusted agent must not be able to put arbitrary bytes into an audit
 *   payload by way of a header we "helpfully" accepted.
 */
import { timingSafeEqual } from 'node:crypto';
import { newId, traceIdFromW3C } from '@permitzero/domain';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  contextFromRequest,
  formatTraceparent,
  statusClass,
  type MetricsBundle,
  type TraceContext,
} from '@permitzero/observability';
import type { Db } from '@permitzero/db';
import { verifyAuditChain, withTenantBlindTransaction, withTenantTransaction } from '@permitzero/db';

declare module 'fastify' {
  interface FastifyRequest {
    traceContext: TraceContext;
  }
}

export interface ObservabilityDeps {
  metrics: MetricsBundle;
  /**
   * Refresh the database-backed gauges just before a scrape. Called from the
   * /metrics handler rather than on a timer so an idle process costs nothing and
   * a scrape always sees current numbers.
   */
  refresh?: () => Promise<void>;
}

/**
 * Start the request timer and adopt or create the trace context.
 *
 * Registered as `onRequest` rather than `preHandler` so requests rejected by
 * authentication or the rate limiter — the ones an operator most wants to see —
 * are still measured and still get a trace id in their error envelope.
 */
export function installRequestObservability(app: FastifyInstance, deps: ObservabilityDeps): void {
  app.addHook('onRequest', async (request, reply) => {
    (request as { startTime?: number }).startTime = performance.now();
    const { ctx } = contextFromRequest(request.headers['traceparent']);
    request.traceContext = ctx;
    // `traceId` is what the error envelope and the audit chain already use, and
    // it is validated as `trc_` + 26 Crockford base32 characters. A W3C trace id
    // is 32 hex, so it is base-converted rather than pasted: `traceIdFromW3C`
    // maps 128 bits into exactly 26 symbols, losslessly and deterministically,
    // which makes a log line, an HTTP error, an audit event and the caller's own
    // trace all one query instead of four unrelated identifiers.
    request.traceId = traceIdFromW3C(ctx.traceId) ?? newId('trace');
    // Not `request.setLogContext({ traceId })`: that method does not exist in the
    // Fastify version this app is pinned to (5.2), and calling it unconditionally
    // from this hook 500s every routed request — which is exactly what it did the
    // first time the logger was switched on and something finally printed it.
    // Correlation therefore travels as an explicit field on the log calls that
    // matter (the error handler passes `{ traceId }`) plus the `traceparent` header
    // echoed below.
    reply.header('traceparent', formatTraceparent(ctx));
  });

  app.addHook('onResponse', async (request, reply) => {
    const started = (request as { startTime?: number }).startTime;
    // Unrouted requests have no routeOptions.url; collapsing them into one label
    // keeps a port scanner from minting a series per probe.
    const route = request.routeOptions?.url ?? 'unmatched';
    const cls = statusClass(reply.statusCode);
    deps.metrics.httpRequests.inc({ route, method: request.method, status_class: cls });
    if (started !== undefined) {
      deps.metrics.httpDuration.observe({ route, method: request.method }, (performance.now() - started) / 1000);
    }
  });
}

/**
 * `GET /metrics`.
 *
 * Guarded by a dedicated bearer token (`METRICS_TOKEN`) rather than tenant
 * credentials, and absent when that token is not configured.
 *
 * Why not reuse the API's credential model: a scraper is a platform component
 * with no tenant, so minting it a service credential would put infrastructure
 * polling inside the tenant table and the audit chain it is meant to observe.
 * Why not leave it open: the exposition names every route, its volumes and
 * error rates, queue depth, and — via `pz_tenant_isolation_enforced` — whether
 * this deployment is currently enforcing tenant isolation at all. That is a
 * reconnaissance gift and an operational disclosure, for a service that holds
 * other people's financial control plane. Prometheus supports bearer-scraped
 * targets natively, so the cost is one header on the scrape config.
 */
export interface MetricsRouteDeps {
  metrics: MetricsBundle;
  /** Null disables the endpoint entirely: no route to probe, no way to fail open. */
  token: string | null;
  refresh?: () => Promise<void>;
}

/** Length-independent constant-time comparison, so the token is not a timing oracle. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on unequal lengths; padding a comparison to a common
  // length would leak nothing but is slower to read than just failing early on a
  // length mismatch, which is itself not secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function metricsRoute(app: FastifyInstance, deps: MetricsRouteDeps): Promise<void> {
  if (deps.token === null) return;
  app.get('/metrics', { exposeHeadRoute: false }, async (request, reply) => {
    const header = request.headers.authorization;
    const presented = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
    if (!presented || !tokenMatches(presented, deps.token as string)) {
      return reply
        .status(401)
        .header('www-authenticate', 'Bearer realm="permitzero-metrics"')
        .send({ error: { code: 'UNAUTHENTICATED', message: 'Metrics require a bearer token.', retryable: false } });
    }
    if (deps.refresh) await deps.refresh();
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(await deps.metrics.scrape());
  });
}

/**
 * The age of the oldest outbox row that has not been published yet, in seconds.
 *
 * Read from `outbox_events` rather than from the queue, because the queue is
 * not where the backlog lives when delivery is broken. A wedged dispatcher
 * drains nothing and publishes nothing: thousands of rows sit in Postgres
 * while the queue is empty, so the queue's own age reads zero and the stall
 * alert never fires. The row is the unit of work, so the row is what is
 * measured.
 *
 * `DEAD` rows are excluded on purpose. A dead-lettered row is a delivery that
 * failed, not one that is late — it has its own signal
 * (`pz_outbox_events{status="DEAD"}`), and including it here would pin the lag
 * gauge high forever for a row that is never going to be published without an
 * operator redriving it.
 */
export async function oldestUnpublishedOutboxAgeSeconds(db: Db): Promise<number> {
  // The cross-tenant read the delivery worker already makes: `outbox_events`
  // carries the `dispatch_read` policy, so the blind transaction is the
  // supported way to see every tenant's backlog. A tenant-scoped transaction
  // would answer for one tenant only, and the lag an operator sees has to be
  // the worst one, not the one whose id happened to be in scope.
  //
  // `now()` is the database's own clock, because `created_at` is the
  // database's clock too. Measuring a database timestamp against the
  // application host's clock makes the answer depend on how far the two hosts
  // have drifted, and a deployment whose database is a second ahead would
  // report a negative age.
  const rows = (await withTenantBlindTransaction(db, (tx) =>
    tx.execute(sql`
      SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) AS age_seconds
        FROM outbox_events
       WHERE status IN ('PENDING', 'FAILED')
    `),
  )) as unknown as Array<{ age_seconds: string | number | null }>;
  // No unpublished row: MIN() is NULL and so is the difference. Zero is the
  // honest answer — nothing is lagging — and not "unknown", which would be
  // indistinguishable from a query that failed.
  const raw = rows[0]?.age_seconds;
  if (raw === null || raw === undefined) return 0;
  const age = Number(raw);
  return Number.isFinite(age) && age > 0 ? age : 0;
}

/** Every tenant id, read through the door policy's blind transaction. */
async function listTenantIds(db: Db): Promise<string[]> {
  const rows = (await withTenantBlindTransaction(db, (tx) =>
    tx.execute(sql`SELECT id FROM tenants ORDER BY id`),
  )) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export interface AuditChainSweep {
  /** Tenants whose chain was verified in this sweep. */
  tenants: number;
  /** Total breaks found across every verified tenant. */
  breaks: number;
}

/**
 * Verify the audit hash chain for every tenant and count the breaks.
 *
 * This is the zero-tolerance `audit-integrity` objective, and it can only be
 * measured by actually recomputing the chain: the trigger that assigns each
 * sequence and checks the `previous_hash` link protects the write path, but
 * nothing in the database recomputes a hash after the fact, so a row whose
 * bytes changed under the trigger's back would verify fine until somebody
 * looked. `verifyAuditChain()` is that look.
 *
 * Each tenant is verified in its own tenant-scoped transaction, so the read
 * goes through row-level security exactly as the application reads that
 * tenant's rows — the verification is not a back door around the boundary it
 * is checking.
 */
export async function verifyAuditChains(db: Db, opts: { hmacKey?: string | null } = {}): Promise<AuditChainSweep> {
  const tenantIds = await listTenantIds(db);
  let breaks = 0;
  for (const tenantId of tenantIds) {
    const result = await withTenantTransaction(db, tenantId, (tx) =>
      verifyAuditChain(tx, tenantId, { hmacKey: opts.hmacKey ?? null }),
    );
    breaks += result.breaks.length;
  }
  return { tenants: tenantIds.length, breaks };
}

/**
 * How long a verification result is reused before the chain is verified again.
 *
 * A full verification recomputes every hash of every tenant's audit trail,
 * which is unbounded work in the number of events — so it cannot run on every
 * scrape. A minute is short enough that a break is on the dashboard within a
 * scrape or two, and long enough that a busy deployment pays for it once a
 * minute rather than once every fifteen seconds.
 */
export const AUDIT_CHAIN_SWEEP_INTERVAL_MS = 60_000;

/**
 * Verifies the audit chain on demand and remembers the answer for a while.
 *
 * The alternative — verifying on every scrape — is unbounded in the number of
 * audit events, and a scrape that takes longer than Prometheus's timeout takes
 * the whole target down rather than reporting a slow gauge. The cache makes
 * the cost proportional to the interval instead of to the scrape rate.
 *
 * A verification that throws propagates to the caller rather than being
 * swallowed: the caller decides what to publish, and publishing "the chain is
 * fine" because the check could not run would be the one lie this gauge must
 * never tell.
 */
export class AuditChainMonitor {
  private lastRunAtMs = 0;
  private lastResult: AuditChainSweep | null = null;
  private inFlight: Promise<AuditChainSweep> | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: { hmacKey?: string | null; sweepIntervalMs?: number } = {},
  ) {}

  /** The most recent sweep, running a new one first if the cached one is stale. */
  async refresh(): Promise<AuditChainSweep | null> {
    // Two scrapes at once must not start two sweeps.
    if (this.inFlight) return this.inFlight;
    const interval = this.opts.sweepIntervalMs ?? AUDIT_CHAIN_SWEEP_INTERVAL_MS;
    if (this.lastResult && Date.now() - this.lastRunAtMs < interval) return this.lastResult;
    this.inFlight = verifyAuditChains(this.db, { hmacKey: this.opts.hmacKey ?? null });
    try {
      this.lastResult = await this.inFlight;
      // Measured from the end of the sweep: a slow verification must not be
      // followed immediately by another one.
      this.lastRunAtMs = Date.now();
      return this.lastResult;
    } finally {
      this.inFlight = null;
    }
  }
}
