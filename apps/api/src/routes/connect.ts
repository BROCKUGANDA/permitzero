/**
 * Connected-account routes: the OAuth seam between a tenant and its own
 * payment-provider account.
 *
 * Who authenticates what:
 *  - `start`, list and delete are normal authenticated tenant routes (the
 *    tenant comes from the principal, never the URL).
 *  - The provider's redirect hits `callback` WITHOUT a bearer token — the
 *    tenant identity rides inside a short-lived, HMAC-signed state value that
 *    only this server could have produced. That is the entire trust argument
 *    for accepting an unauthenticated browser redirect, and it is why the
 *    state is signed, expired, and provider-bound rather than guessed.
 *
 * Token discipline: the code-exchange result exists in memory for exactly as
 * long as it takes to encrypt-and-store it. Responses never contain token
 * material; list/delete see only references. Linking and revocation are
 * audited as outbox events like every other administrative change.
 */
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { buildAuthorizeUrl, exchangeAuthorizationCode } from '@permitzero/connectors';
import type { WiseOAuthConfig } from '@permitzero/connectors';
import {
  connectOAuthConfigFromEnv,
  insertConnectedAccount,
  insertOutboxEvent,
  listConnectedAccounts,
  revokeConnectedAccount,
  tenantScope,
} from '@permitzero/db';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@permitzero/domain';
import type { ConnectedAccountRecord } from '@permitzero/domain';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';

const PROVIDER = 'wise';
const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  t: string; // tenant id
  a: string; // actor id
  p: string; // provider
  n: string; // nonce
  e: number; // expiry epoch ms
}

/** A purpose-bound MAC: the permit-signing key must never directly authenticate anything but permits. */
function stateMac(signingKey: string): HmacLike {
  return createHmac('sha256', `pz:connect-state:v1:${signingKey}`);
}

interface HmacLike {
  update(input: string): HmacLike;
  digest(encoding: 'base64url'): string;
}

function signState(payload: StatePayload, signingKey: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = stateMac(signingKey).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyState(raw: string, signingKey: string): StatePayload {
  const [body, mac] = raw.split('.');
  if (!body || !mac) throw new ForbiddenError('Malformed OAuth state.');
  const expected = stateMac(signingKey).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ForbiddenError('OAuth state failed verification.');
  }
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    throw new ForbiddenError('Malformed OAuth state.');
  }
  if (payload.p !== PROVIDER) throw new ForbiddenError('OAuth state names a different provider.');
  if (typeof payload.e !== 'number' || payload.e < Date.now()) {
    throw new ForbiddenError('OAuth state expired; start the connection again.');
  }
  return payload;
}

/** The connected account as the API sees it: references only, never tokens. */
function toConnectedAccountDto(record: ConnectedAccountRecord) {
  return {
    connected_account_id: record.connectedAccountId,
    provider: record.provider,
    display_name: record.displayName,
    external_profile_id: record.externalProfileId,
    status: record.status,
    connected_by: record.connectedBy,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export async function connectRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  const oauthValues = connectOAuthConfigFromEnv(process.env);
  if (!oauthValues) {
    // Live finance is off: register nothing. A deployment that later enables
    // it gets these routes by restarting with the configuration present.
    return;
  }
  const oauthConfig: WiseOAuthConfig = {
    clientId: oauthValues.clientId,
    clientSecret: oauthValues.clientSecret,
    authorizeUrl: oauthValues.authorizeUrl,
    tokenUrl: oauthValues.tokenUrl,
    redirectUri: oauthValues.redirectUri,
    scopes: oauthValues.scopes,
  };

  // -- Start: authenticated; hands the browser to the provider ----------------
  app.get('/connect/wise/start', async (request, reply) => {
    const principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
    if (!principal) throw new UnauthenticatedError();
    const state = signState(
      {
        t: principal.tenantId,
        a: principal.actorId,
        p: PROVIDER,
        n: randomUUID(),
        e: Date.now() + STATE_TTL_MS,
      },
      ctx.config.permitSigningKey,
    );
    return reply.redirect(buildAuthorizeUrl(oauthConfig, state), 302);
  });

  // -- Callback: unauthenticated; trust rides on the signed state -------------
  app.get('/connect/wise/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    if (typeof query.state !== 'string' || typeof query.code !== 'string') {
      throw new ForbiddenError('The provider redirect is missing its code or state.');
    }
    const state = verifyState(query.state, ctx.config.permitSigningKey);

    const tokenResponse = await exchangeAuthorizationCode(oauthConfig, query.code, fetch);
    // The Wise profile the token acts on: prefer the business profile, fall
    // back to the first profile returned.
    const profilesOrigin = new URL(oauthConfig.tokenUrl).origin;
    const profilesResponse = await fetch(`${profilesOrigin}/v1/profiles`, {
      headers: { Authorization: `Bearer ${tokenResponse.accessToken}` },
    });
    if (!profilesResponse.ok) {
      throw new ForbiddenError('Could not read the Wise profile after authorization; try connecting again.');
    }
    const profiles = (await profilesResponse.json()) as Array<{ id?: unknown; type?: unknown }>;
    const business = profiles.find((p) => p.type === 'business' && typeof p.id === 'number' && p.id > 0);
    const chosen = business ?? profiles.find((p) => typeof p.id === 'number' && p.id > 0);
    if (!chosen) {
      throw new ForbiddenError('The Wise account has no usable profile; try connecting again.');
    }

    const scope = await tenantScope(ctx.runtime, state.t);
    const record = await scope(async (ex) => {
      const inserted = await insertConnectedAccount(
        ex,
        {
          tenantId: state.t,
          provider: PROVIDER,
          displayName: `Wise profile ${chosen.id}`,
          externalProfileId: String(chosen.id),
          scopes: oauthValues.scopes,
          connectedBy: state.a,
          token: {
            accessToken: tokenResponse.accessToken,
            refreshToken: tokenResponse.refreshToken,
            expiresAt: tokenResponse.expiresAt,
            scope: tokenResponse.scope,
          },
        },
        ctx.config.auditHmacKey,
      );
      await insertOutboxEvent(ex, {
        tenantId: state.t,
        aggregateType: 'connected_account',
        aggregateId: inserted.connectedAccountId,
        eventType: 'connected_account.linked',
        queueName: 'pz.outbox',
        payload: {
          provider: PROVIDER,
          external_profile_id: inserted.externalProfileId,
          connected_by: state.a,
        },
      });
      return inserted;
    });
    return reply.code(200).send(toConnectedAccountDto(record));
  });

  // -- List: authenticated, redacted ------------------------------------------
  app.get('/connected-accounts', async (request) => {
    const principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
    if (!principal) throw new UnauthenticatedError();
    const scope = await tenantScope(ctx.runtime, principal.tenantId);
    const rows = await scope(async (ex) => listConnectedAccounts(ex, principal.tenantId));
    return { items: rows.map((row) => toConnectedAccountDto(recordOf(row))) };
  });

  // -- Delete: authenticated; revokes locally and detaches connectors ---------
  app.delete('/connected-accounts/:id', async (request) => {
    const principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
    if (!principal) throw new UnauthenticatedError();
    const { id } = request.params as { id: string };
    const scope = await tenantScope(ctx.runtime, principal.tenantId);
    const removed = await scope(async (ex) => {
      const ok = await revokeConnectedAccount(ex, principal.tenantId, id, new Date());
      if (ok) {
        await insertOutboxEvent(ex, {
          tenantId: principal.tenantId,
          aggregateType: 'connected_account',
          aggregateId: id,
          eventType: 'connected_account.revoked',
          queueName: 'pz.outbox',
          payload: { provider: PROVIDER, revoked_by: principal.actorId },
        });
      }
      return ok;
    });
    if (!removed) {
      // Cross-tenant deletes surface as 404, never 403 (PRD §7.5).
      throw new NotFoundError();
    }
    return { revoked: true, connected_account_id: id };
  });
}

/** listConnectedAccounts returns rows; map them through the same redaction. */
function recordOf(row: Parameters<typeof Object>[0]): ConnectedAccountRecord {
  // The mapper lives in @permitzero/db; re-derive the DTO from the row shape
  // without exposing the token envelope.
  const r = row as Record<string, unknown>;
  return {
    connectedAccountId: r['connectedAccountId'] as string,
    tenantId: r['tenantId'] as string,
    provider: r['provider'] as string,
    displayName: r['displayName'] as string,
    externalProfileId: r['externalProfileId'] as string,
    status: r['status'] as ConnectedAccountRecord['status'],
    scopes: (r['scopesJson'] as readonly string[]) ?? [],
    connectedBy: r['connectedBy'] as string,
    createdAt: r['createdAt'] as Date,
    updatedAt: r['updatedAt'] as Date,
  };
}
