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
import {
  contextFromRequest,
  formatTraceparent,
  statusClass,
  type MetricsBundle,
  type TraceContext,
} from '@permitzero/observability';

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
