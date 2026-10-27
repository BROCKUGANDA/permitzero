/**
 * Action routes: intake, reads, approvals, execute. Every route here requires
 * authentication; the tenant always comes from the principal, never the URL.
 */
import {
  actionDtoSchema,
  actionIdSchema,
  approveActionRequestSchema,
  createActionRequestSchema,
  createActionResponseSchema,
  executeActionRequestSchema,
  executeActionResponseSchema,
  pageSchema,
  paginationQuerySchema,
  permitDtoSchema,
  rejectActionRequestSchema,
} from '@permitzero/schemas';
import { z } from 'zod';
import { getAction, listActions, tenantScope } from '@permitzero/db';
import { NotFoundError } from '@permitzero/domain';
import type { ActionState } from '@permitzero/domain';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { rateLimitPresets } from '../app.js';
import { authenticateToken } from '../auth.js';
import { intakeAction } from '../intake.js';
import { decideApproval } from '../approvals.js';
import { collectPermit } from '../permits.js';
import { executeApprovedAction } from '../execute.js';
import { toActionDto } from '../dto.js';

const actionParamsSchema = z.object({ id: actionIdSchema }).strict();

const actionQuerySchema = paginationQuerySchema.extend({
  state: z.string().max(32).optional(),
  tool_name: z.string().max(128).optional(),
  agent_id: z.string().max(128).optional(),
  run_id: z.string().max(128).optional(),
});

const actionPageSchema = pageSchema(actionDtoSchema);

async function authHook(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', async (request) => {
    request.principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
  });
}

export async function actionRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  await authHook(app, ctx);
  // Every route below changes state or spends a credential, so each gets the
  // mutation budget from config rather than the global ceiling. The global number
  // is a read-path allowance: applying it to intake means an agent can queue
  // hundreds of proposals per minute against a human approval queue that can only
  // be worked one at a time.
  const { mutation } = rateLimitPresets(ctx.config);

  app.post(
    '/actions',
    {
      schema: {
        body: createActionRequestSchema,
        response: { 200: createActionResponseSchema, 201: createActionResponseSchema },
      },
      config: { rateLimit: mutation },
    },
    async (request, reply) => {
      const result = await intakeAction(ctx.intake, request.principal, request.body, request.traceId);
      return reply.status(result.status).send(result.body);
    },
  );

  app.get(
    '/actions',
    {
      schema: {
        querystring: actionQuerySchema,
        response: { 200: actionPageSchema },
      },
    },
    async (request) => {
      const query = request.query;
      const tenantId = request.principal.tenantId;
      // One tenant-scoped transaction for the whole page. Under 0006 a statement
      // on the root pool has no `app.tenant_id` and reads zero rows, so the list
      // and the per-row DTO reads (revision, approvals, permit, execution) must
      // share the transaction that carries the tenant. They share it rather than
      // each taking their own because a transaction pins one pool connection for
      // its lifetime: one scope per row would be a fresh connection and commit for
      // a 20-row page, and a separate scope for the DTO reads would split one
      // snapshot across commits. No network call may be added inside this block.
      const scope = tenantScope(ctx.runtime, tenantId);
      return scope(async (ex) => {
        const page = await listActions(
          ex,
          tenantId,
          {
            ...(query.state ? { states: [query.state as ActionState] } : {}),
            ...(query.tool_name ? { toolName: query.tool_name } : {}),
            ...(query.agent_id ? { agentId: query.agent_id } : {}),
            ...(query.run_id ? { runId: query.run_id } : {}),
          },
          { limit: query.limit, cursor: query.cursor },
        );
        return {
          // `Promise.all` keeps the row order `listActions` returned; `toActionDto`
          // issues its reads on `ex`, so they pipeline on the pinned connection.
          data: await Promise.all(page.rows.map((row) => toActionDto(ex, tenantId, row))),
          meta: { limit: query.limit, next_cursor: page.nextCursor },
        };
      });
    },
  );

  app.get(
    '/actions/:id',
    {
      schema: {
        params: actionParamsSchema,
        response: { 200: actionDtoSchema },
      },
    },
    async (request) => {
      const tenantId = request.principal.tenantId;
      const scope = tenantScope(ctx.runtime, tenantId);
      // The action row and its DTO reads commit together, so a caller cannot see
      // an action in one state and a permit from a later one. A NotFoundError
      // thrown inside the transaction rolls the (read-only) transaction back and
      // propagates unchanged, so the 404 behaviour is exactly what it was.
      return scope(async (ex) => {
        const row = await getAction(ex, tenantId, request.params.id);
        if (!row) throw new NotFoundError();
        return toActionDto(ex, tenantId, row);
      });
    },
  );

  app.post(
    '/actions/:id/approve',
    {
      schema: {
        params: actionParamsSchema,
        body: approveActionRequestSchema,
        response: { 200: actionDtoSchema },
      },
      config: { rateLimit: mutation },
    },
    async (request) => decideApproval(ctx.approvals, request.principal, request.params.id, request.body),
  );

  app.post(
    '/actions/:id/reject',
    {
      schema: {
        params: actionParamsSchema,
        body: rejectActionRequestSchema,
        response: { 200: actionDtoSchema },
      },
      config: { rateLimit: mutation },
    },
    async (request) => decideApproval(ctx.approvals, request.principal, request.params.id, request.body),
  );

  app.post(
    '/actions/:id/permit',
    {
      schema: {
        params: actionParamsSchema,
        body: z.object({}).strict(),
        response: { 201: permitDtoSchema },
      },
      config: { rateLimit: mutation },
    },
    async (request, reply) =>
      reply.status(201).send(await collectPermit(ctx.collect, request.principal, request.params.id)),
  );

  app.post(
    '/actions/:id/execute',
    {
      schema: {
        params: actionParamsSchema,
        body: executeActionRequestSchema,
        response: { 200: executeActionResponseSchema },
      },
      config: { rateLimit: mutation },
    },
    async (request) => executeApprovedAction(ctx.execute, request.principal, request.params.id, request.body),
  );
}
