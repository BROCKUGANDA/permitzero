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
import { UnauthenticatedError, BadRequestError, ForbiddenError, Role, canonicalHash } from '@permitzero/domain';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';

export async function notificationRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  const sink = new HttpNotificationSink({ allowedHosts: ctx.config.notificationAllowedHosts });

  app.post('/notifications/send', async (request) => {
    const principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
    if (!principal) throw new UnauthenticatedError();
    // Sending a message outside the platform is a privileged consequence, not
    // a read. Agents, approvers and auditors cannot turn their credential into
    // an outbound notification channel.
    if (
      principal.actorType !== 'USER' ||
      (!principal.roles.includes(Role.OWNER) &&
        !principal.roles.includes(Role.POLICY_ADMIN) &&
        !principal.roles.includes(Role.OPERATOR))
    ) {
      throw new ForbiddenError('This credential may not send external notifications.');
    }
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
    // A clock/random delivery id defeats the sink's idempotency on every
    // retry. Use the caller's key when supplied, otherwise a canonical hash
    // of the exact notification, scoped to tenant and actor.
    const supplied =
      typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'].trim() : '';
    if (supplied && (supplied.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(supplied))) {
      throw new BadRequestError(
        'Idempotency-Key must be at most 128 characters using letters, numbers, dot, underscore, colon or dash.',
      );
    }
    const deliveryId = supplied
      ? `notif:${principal.tenantId}:${supplied}`
      : `notif:${canonicalHash({
          tenant_id: principal.tenantId,
          actor_id: principal.actorId,
          destination: body.destination.trim(),
          channel: body.channel.trim(),
          message: body.message,
          severity,
        })}`;
    const outcome = await sink.deliver({
      deliveryId,
      destination: body.destination.trim(),
      channel: body.channel.trim(),
      message: body.message,
      severity,
      tenantId: principal.tenantId,
      traceId: null,
    });
    if (outcome.status === 'DELIVERED') {
      await ctx.stores.audit
        .append({
          tenantId: principal.tenantId,
          actionId: null,
          runId: null,
          actorType: principal.actorType,
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
        .catch((err: unknown) => {
          console.error(
            `[notifications] audit append failed for ${deliveryId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        });
    }
    return {
      outcome: outcome.status,
      receipt: outcome.status === 'DELIVERED' ? outcome.receipt : null,
      errorClass: outcome.status === 'DELIVERED' ? null : outcome.errorClass,
    };
  });
}
