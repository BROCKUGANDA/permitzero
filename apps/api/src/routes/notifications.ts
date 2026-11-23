/**
 * Outbound notification controller — the sink side of the runtime boundary.
 *
 * A notification is a consequence, never an authorization: it leaves
 * PermitZero for a human or an external system. The sink is allowlist-gated
 * and reports honestly (delivered vs retryable vs terminal). The route
 * authenticates the caller, validates the payload, dispatches through the sink,
 * and audits the outcome.
 */
import { HttpNotificationSink } from '@permitzero/connectors';
import { UnauthenticatedError, BadRequestError } from '@permitzero/domain';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';

export async function notificationRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  const sink = new HttpNotificationSink({ allowedHosts: ctx.config.notificationAllowedHosts });

  app.post('/notifications/send', async (request) => {
    const principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
    if (!principal) throw new UnauthenticatedError();
    const body = request.body as { destination?: unknown; channel?: unknown; message?: unknown; severity?: unknown };
    if (typeof body?.destination !== 'string' || body.destination.trim().length === 0) {
      throw new BadRequestError('destination is required.');
    }
    if (typeof body?.channel !== 'string' || body.channel.trim().length === 0) {
      throw new BadRequestError('channel is required.');
    }
    if (typeof body?.message !== 'string' || body.message.trim().length === 0) {
      throw new BadRequestError('message is required.');
    }
    const severity = body.severity === 'warning' || body.severity === 'critical' ? body.severity : 'info';
    const outcome = await sink.deliver({
      deliveryId: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      destination: body.destination.trim(),
      channel: body.channel.trim(),
      message: body.message,
      severity,
      tenantId: principal.tenantId,
      traceId: null,
    });
    if (outcome.status === 'DELIVERED') {
      ctx.stores.audit
        .append({
          tenantId: principal.tenantId,
          actionId: null,
          runId: null,
          actorType: 'USER',
          actorId: principal.actorId,
          eventType: 'notification.sent',
          eventTime: new Date(),
          traceId: null,
          policyRevisionId: null,
          payloadRedacted: {
            destination: outcome.receipt.destination,
            channel: body.channel,
            severity,
            status_code: outcome.receipt.statusCode,
          },
        })
        .catch(() => undefined);
    }
    return { outcome: outcome.status, receipt: outcome.status === 'DELIVERED' ? outcome.receipt : null, errorClass: outcome.status === 'DELIVERED' ? null : outcome.errorClass };
  });
}
