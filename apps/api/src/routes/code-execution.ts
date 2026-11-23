/**
 * Sandboxed code-execution controller — the code-execution action type.
 *
 * Authenticated, validated, audited. The sandbox itself is an adapter in
 * `@permitzero/connectors`; this route is the controller that hands it the
 * request. A denied or failing run produces an honest outcome and an audit
 * event; nothing is silently swallowed.
 */
import { randomUUID } from 'node:crypto';
import { CodeExecutionFinanceConnector } from '@permitzero/connectors';
import { UnauthenticatedError, BadRequestError, ForbiddenError, Role } from '@permitzero/domain';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';
import { deriveCodeExecutionKey, suppliedIdempotencyKey } from '../code-execution-key.js';

export async function codeExecutionRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  const sandbox = new CodeExecutionFinanceConnector({
    connectorId: 'con_code_sandbox',
    data: ctx.stores.data,
    // The controller's contract offers both languages. An allowlist that
    // disagrees with the contract would answer "language must be node or
    // python" and then reject every python request as LANGUAGE_NOT_ALLOWED.
    allowedLanguages: ['node', 'python'],
    timeoutMs: 10_000,
  });

  app.post('/code-execution/run', async (request) => {
    const principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
    if (!principal) throw new UnauthenticatedError();
    // This controller bypasses the broker's permit/policy path and hands the
    // body to a real interpreter, so authentication alone is not enough. Only
    // a tenant's administrative principals may reach it; an agent, approver,
    // auditor or service credential must not be able to turn a bearer token
    // into code running as the API's OS user.
    if (
      principal.actorType !== 'USER' ||
      (!principal.roles.includes(Role.OWNER) && !principal.roles.includes(Role.POLICY_ADMIN))
    ) {
      throw new ForbiddenError('This credential may not submit code for execution.');
    }
    const body = request.body as { code?: unknown; language?: unknown; args?: unknown };
    if (typeof body?.code !== 'string' || body.code.trim().length === 0) {
      throw new BadRequestError('code is required.');
    }
    if (body.language !== 'node' && body.language !== 'python') {
      throw new BadRequestError('language must be "node" or "python".');
    }
    const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === 'string') : [];
    // A clock-derived key would make retries re-execute the snippet: the
    // connector dedupes on this value, so it has to describe the request, not
    // the moment the request arrived. A caller-supplied key wins, scoped to
    // the tenant so two callers cannot collide by picking the same string.
    const supplied = suppliedIdempotencyKey(request.headers['idempotency-key']);
    const idempotencyKey = supplied
      ? `code:${principal.tenantId}:${supplied}`
      : deriveCodeExecutionKey({
          tenantId: principal.tenantId,
          actorId: principal.actorId,
          code: body.code,
          language: body.language,
          args,
        });
    const outcome = await sandbox.executeCode({
      tenantId: principal.tenantId,
      connectorId: 'con_code_sandbox',
      idempotencyKey,
      code: body.code,
      language: body.language as 'node' | 'python',
      args,
      actionId: `act_code_${idempotencyKey.slice(-12)}`,
      executionId: `exe_code_${idempotencyKey.slice(-12)}`,
      traceId: `trc_${randomUUID()}`,
    });
    // Await the audit write: a response that says "executed" but whose audit
    // record failed is a false claim. The idempotency key makes a retry safe.
    await ctx.stores.audit
      .append({
        tenantId: principal.tenantId,
        actionId: null,
        runId: null,
        actorType: principal.actorType,
        actorId: principal.actorId,
        eventType: 'code.executed',
        eventTime: new Date(),
        traceId: null,
        policyRevisionId: null,
        payloadRedacted: {
          language: body.language,
          outcome: outcome.status,
          error_class: outcome.status === 'SUCCEEDED' ? null : (outcome as { errorClass: string }).errorClass,
        },
      })
      // A code execution with no audit record is a hole in the control plane.
      // The caller must not receive a clean success in that case.
      .catch((err: unknown) => {
        console.error(
          `[code-execution] audit append failed for ${idempotencyKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      });
    return {
      outcome: outcome.status,
      errorClass: outcome.status === 'SUCCEEDED' ? null : (outcome as { errorClass: string }).errorClass,
    };
  });
}
