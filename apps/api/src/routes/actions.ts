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
import { getAction, listActions } from '@permitzero/db';
import { NotFoundError } from '@permitzero/domain';
import type { ActionState } from '@permitzero/domain';
import type { AppContext, ZodFastifyInstance } from '../app.js';
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
    request.principal = await authenticateToken(ctx.db.db, request.headers.authorization, new Date());
  });
}

export async function actionRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  await authHook(app, ctx);

  app.post(
    '/actions',
    {
      schema: {
        body: createActionRequestSchema,
        response: { 200: createActionResponseSchema, 201: createActionResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await intakeAction(ctx.intake, request.principal, request.body);
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
      const page = await listActions(
        ctx.db.db,
        request.principal.tenantId,
        {
          ...(query.state ? { states: [query.state as ActionState] } : {}),
          ...(query.tool_name ? { toolName: query.tool_name } : {}),
          ...(query.agent_id ? { agentId: query.agent_id } : {}),
          ...(query.run_id ? { runId: query.run_id } : {}),
        },
        { limit: query.limit, cursor: query.cursor },
      );
      return {
        data: await Promise.all(page.rows.map((row) => toActionDto(ctx.db.db, request.principal.tenantId, row))),
        meta: { limit: query.limit, next_cursor: page.nextCursor },
      };
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
      const row = await getAction(ctx.db.db, request.principal.tenantId, request.params.id);
      if (!row) throw new NotFoundError();
      return toActionDto(ctx.db.db, request.principal.tenantId, row);
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
    },
    async (request) => executeApprovedAction(ctx.execute, request.principal, request.params.id, request.body),
  );
}
