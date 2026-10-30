/**
 * The alert sink: the end of the alerting path.
 *
 * Prometheus evaluates the rules; this is where a firing rule is supposed to
 * arrive. The deployed stack had a receiver whose URL was unset by default, so
 * the rules evaluated, the notifications went to a black hole, and the
 * alerting posture was a file nobody read. A rule that fires and reaches
 * nothing is not an alerting system — it is a report generator.
 *
 * The sink RECORDS rather than acts. It counts the alert and writes a
 * structured log line, because the value of an alert that reaches the
 * application is that the application now holds evidence that it fired.
 * Escalating to a human from here would be a second alerting system with
 * none of the context, and one that pages from inside the thing being
 * monitored.
 *
 * It is authenticated with a shared secret, presented in a header rather than
 * in the body, because the body belongs to the Alertmanager.
 *
 * Two carriers are accepted, and the reason is not politeness:
 *
 *   · `x-alert-token` is the explicit channel, and the one a client that is
 *     not the Alertmanager would use.
 *   · `Authorization: Bearer <token>` is what the pinned Alertmanager
 *     (prom/alertmanager:v0.27.0, set in infra/docker-compose.yml) can
 *     actually send. That release has no `http_headers` support at all —
 *     `prometheus/common` did not gain it until after the version it vendors
 *     — so a custom header cannot be configured into it, and a sink that
 *     demanded one would be a sink nothing can reach.
 *
 * The expected secret is `ALERT_INGEST_TOKEN` when it is set, and the metrics
 * token otherwise. The metrics token is the fallback because it is the one
 * secret the observability stack already stages into a file the Alertmanager
 * can read (`/etc/alertmanager/pz_metrics_token`, written by the deployment
 * script from `METRICS_TOKEN`), so the alerting path works in the deployment
 * as it stands rather than after a change to files this change does not own.
 * A dedicated token is strictly better and is what the coordinator should
 * wire up; the fallback is what makes the control true today.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DomainError, ErrorCode, UnauthenticatedError } from '@permitzero/domain';
import type { AppContext, ZodFastifyInstance } from '../app.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The route does not present a tenant credential, so the per-credential
     * budget must not be charged against it.
     *
     * The Alertmanager authenticates with the alerting secret, not with a
     * credential that belongs to a tenant, and a flapping rule must not be
     * able to spend the budget of whatever credential shares the process with
     * it. The global limit still applies: an endpoint that accepts a body
     * from anyone who can reach it is exactly what the global ceiling is for.
     */
    exemptFromAuthBudget?: boolean;
  }
}

/**
 * Label and annotation maps.
 *
 * The values are allowed to be numbers or booleans as well as strings, even
 * though the Alertmanager sends strings: a receiver that answers 422 to a
 * notification because one label was not a string is a receiver that drops
 * notifications, and dropping them is the failure this route exists to
 * remove.
 */
const labelMap = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const alertSchema = z.object({
  status: z.string().optional(),
  labels: labelMap.optional(),
  annotations: labelMap.optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().optional(),
});

/**
 * The Alertmanager webhook payload.
 *
 * Only the fields this sink reads are declared, and every one of them is
 * optional except the alert list: a receiver that rejects a notification
 * because the sender added a field is a receiver that drops notifications,
 * which is the failure this route exists to remove.
 */
const webhookSchema = z.object({
  version: z.string().optional(),
  groupKey: z.string().optional(),
  truncatedAlerts: z.number().optional(),
  status: z.string().optional(),
  receiver: z.string().optional(),
  groupLabels: labelMap.optional(),
  commonLabels: labelMap.optional(),
  commonAnnotations: labelMap.optional(),
  externalURL: z.string().optional(),
  alerts: z.array(alertSchema).default([]),
});

/** Length-independent constant-time comparison, so the token is not a timing oracle. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on unequal lengths; padding the comparison to a
  // common length would leak nothing but is slower to read than failing early
  // on a length mismatch, which is itself not secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The secret the sink expects, or null when none is configured.
 *
 * Read from the environment on every request rather than captured at
 * registration, so an operator can rotate the token without a restart — and
 * so a test can set it. `config.ts` does not carry the field yet; the
 * coordinator owns that file.
 */
export function expectedAlertToken(ctx: AppContext): string | null {
  const dedicated = process.env['ALERT_INGEST_TOKEN']?.trim();
  if (dedicated) return dedicated;
  // The metrics token is the fallback, not a second way in: it is the secret
  // the observability stack already stages where the Alertmanager can read
  // it, so the alerting path is closed by default rather than open.
  return ctx.config.metricsToken;
}

/** The presented secret, from either carrier. */
export function presentedAlertToken(headers: Record<string, unknown>): string | null {
  const explicit = headers['x-alert-token'];
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const authorization = headers['authorization'];
  if (typeof authorization === 'string') {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (bearer?.[1]) return bearer[1].trim();
  }
  return null;
}

/**
 * The severity of an alert, folded into a bounded set.
 *
 * The label comes from the payload, so it is not a value to trust with a
 * metric label: an unbounded label set is the standard way to turn a
 * monitoring feature into a denial of service against the metrics backend.
 */
export function alertSeverity(labels: Record<string, unknown> | undefined): 'page' | 'ticket' | 'unknown' {
  const severity = labels?.['severity'];
  if (severity === 'page') return 'page';
  if (severity === 'ticket') return 'ticket';
  return 'unknown';
}

export async function alertSinkRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  app.post(
    '/internal/alerts',
    {
      schema: { body: webhookSchema },
      config: { exemptFromAuthBudget: true },
    },
    async (request, reply) => {
      const expected = expectedAlertToken(ctx);
      const body = request.body as z.infer<typeof webhookSchema>;
      const alerts = body.alerts ?? [];

      if (!expected) {
        // No secret configured. The sink accepts nothing rather than
        // everything: an endpoint that records whatever it is told is a
        // forgery channel, and the honest answer is that the alerting path
        // is not configured, said out loud instead of quietly discarded.
        ctx.metrics.alertsReceived.inc({ outcome: 'rejected', severity: 'unknown' });
        throw new DomainError('The alert sink has no token configured.', {
          code: ErrorCode.ENFORCEMENT_UNAVAILABLE,
          httpStatus: 503,
          retryable: true,
        });
      }

      const presented = presentedAlertToken(request.headers as Record<string, unknown>);
      if (!presented || !tokenMatches(presented, expected)) {
        ctx.metrics.alertsReceived.inc({ outcome: 'rejected', severity: 'unknown' });
        throw new UnauthenticatedError('The alert sink requires a valid token.');
      }

      // Counted per alert, so the number on the dashboard is the number of
      // alerts that arrived rather than the number of notifications the
      // Alertmanager happened to batch together.
      for (const alert of alerts) {
        ctx.metrics.alertsReceived.inc({ outcome: 'accepted', severity: alertSeverity(alert.labels) });
      }
      if (alerts.length === 0) {
        ctx.metrics.alertsReceived.inc({ outcome: 'accepted', severity: 'unknown' });
      }

      // One structured line per notification, not per alert: a rule that
      // groups twenty alerts into one notification must not become twenty log
      // lines, and the names of the alerts belong in the line.
      const names = alerts
        .map((alert) => alert.labels?.['alertname'])
        .filter((name): name is string => typeof name === 'string')
        .slice(0, 10);
      request.log.warn(
        {
          alerts: alerts.length,
          alertnames: names,
          severity: alertSeverity(body.commonLabels),
          status: body.status,
          receiver: body.receiver,
          groupKey: body.groupKey,
          truncated: body.truncatedAlerts ?? 0,
        },
        'alert received by the permitzero sink',
      );

      return reply.status(202).send({ status: 'accepted', alerts: alerts.length });
    },
  );
}
