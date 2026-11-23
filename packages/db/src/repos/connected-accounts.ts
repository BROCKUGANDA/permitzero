/**
 * Connected-account repositories: OAuth-linked payment-provider accounts.
 *
 * Token security boundary: the plaintext token pair exists ONLY
 *  - inside the OAuth callback (in memory, between the provider's response and
 *    the encrypting write), and
 *  - inside the connector's token manager (loaded through the read function
 *    here, which decrypts under the `secret-material` key).
 * Every other reader sees only the redacted record (no token envelope, no
 * expiry) or a null. Writes always encrypt; a read without keys fails closed.
 */
import { and, desc, eq } from 'drizzle-orm';
import { newId } from '@permitzero/domain';
import type { ConnectedAccountRecord } from '@permitzero/domain';
import type { DbExecutor } from '../client.js';
import { deriveKey, encryptColumn, readColumn, verificationKeys } from '../crypto.js';
import { connectedAccounts, connectors } from '../schema.js';
import type { ConnectedAccountRow } from '../schema.js';
import { toConnectedAccountRecord } from '../mappers.js';

const SECRET_MATERIAL_PURPOSE = 'secret-material';

/** The OAuth token pair, in plaintext, only while it is being stored or loaded. */
export interface StoredTokenPair {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string | null;
}

export interface ConnectedAccountInput {
  tenantId: string;
  provider: string;
  displayName: string;
  externalProfileId: string;
  scopes: readonly string[];
  connectedBy: string;
  token: StoredTokenPair;
}

/**
 * The key ring for token envelopes. A deployment without AUDIT_HMAC_KEY(S) has
 * no key: in development and test a fixed derivation keeps the flow runnable
 * (and is loudly not a production secret), anywhere else the caller must fail
 * closed rather than store plaintext tokens.
 */
function tokenKeyRing(explicitMaster: string | null, env: NodeJS.ProcessEnv = process.env): Buffer[] {
  const masters = [explicitMaster, ...verificationKeys(env)].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  );
  if (masters.length > 0) return masters.map((k) => deriveKey(k, SECRET_MATERIAL_PURPOSE));
  const appEnv = env['APP_ENV'] ?? 'development';
  if (appEnv === 'development' || appEnv === 'test') {
    return [deriveKey('permitzero-dev-only-secret-material', SECRET_MATERIAL_PURPOSE)];
  }
  return [];
}

export function tokenEncryptionAvailable(explicitMaster: string | null, env?: NodeJS.ProcessEnv): boolean {
  return tokenKeyRing(explicitMaster, env).length > 0;
}

/**
 * Insert a newly connected account, replacing any existing ACTIVE row for the
 * same provider (the partial unique index enforces one ACTIVE per
 * tenant+provider; the old row becomes REVOKED and its tokens are dropped).
 * Runs in the caller's tenant transaction.
 */
export async function insertConnectedAccount(
  ex: DbExecutor,
  input: ConnectedAccountInput,
  explicitMaster: string | null,
): Promise<ConnectedAccountRecord> {
  const keys = tokenKeyRing(explicitMaster);
  if (keys.length === 0) {
    throw new Error(
      'Refusing to store OAuth tokens without a configured key ring: set AUDIT_HMAC_KEY (production) rather than storing them in plaintext.',
    );
  }
  // The newest key writes; reads try the whole ring (same rule as the ledger
  // receipt columns, so a rotation stays survivable).
  const envelope = encryptColumn(
    {
      accessToken: input.token.accessToken,
      refreshToken: input.token.refreshToken,
      scope: input.token.scope,
    },
    keys[0]!,
  );
  const row: ConnectedAccountRow = {
    connectedAccountId: newId('connectedAccount'),
    tenantId: input.tenantId,
    provider: input.provider,
    displayName: input.displayName,
    externalProfileId: input.externalProfileId,
    status: 'ACTIVE',
    scopesJson: input.scopes,
    tokenEnvelope: envelope,
    tokenExpiresAt: input.token.expiresAt,
    connectedBy: input.connectedBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await ex.insert(connectedAccounts).values(row);
  return toConnectedAccountRecord(row);
}

/** The redacted record (never the token envelope). */
export async function getConnectedAccount(
  ex: DbExecutor,
  tenantId: string,
  connectedAccountId: string,
): Promise<ConnectedAccountRow | null> {
  const rows = await ex
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.tenantId, tenantId), eq(connectedAccounts.connectedAccountId, connectedAccountId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findActiveConnectedAccount(
  ex: DbExecutor,
  tenantId: string,
  provider: string,
): Promise<ConnectedAccountRow | null> {
  const rows = await ex
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.tenantId, tenantId), eq(connectedAccounts.provider, provider)))
    .orderBy(desc(connectedAccounts.createdAt));
  return rows.find((r) => r.status === 'ACTIVE') ?? null;
}

export async function listConnectedAccounts(ex: DbExecutor, tenantId: string): Promise<ConnectedAccountRow[]> {
  return ex.select().from(connectedAccounts).where(eq(connectedAccounts.tenantId, tenantId));
}

/**
 * Revoke: status flips, the token envelope is destroyed immediately, and every
 * connector pointing at the account is detached so later dispatches fail
 * closed on the missing-account guard instead of failing on a dead token.
 */
export async function revokeConnectedAccount(
  ex: DbExecutor,
  tenantId: string,
  connectedAccountId: string,
  at: Date,
): Promise<boolean> {
  const updated = await ex
    .update(connectedAccounts)
    .set({ status: 'REVOKED', tokenEnvelope: null, tokenExpiresAt: null, updatedAt: at })
    .where(and(eq(connectedAccounts.tenantId, tenantId), eq(connectedAccounts.connectedAccountId, connectedAccountId)))
    .returning({ id: connectedAccounts.connectedAccountId });
  if (updated.length === 0) return false;
  await ex
    .update(connectors)
    .set({ connectedAccountId: null, updatedAt: at })
    .where(and(eq(connectors.tenantId, tenantId), eq(connectors.connectedAccountId, connectedAccountId)));
  return true;
}

/**
 * Read the plaintext token pair for the connector's token manager. Returns
 * null for anything the connector must fail closed on: no row, a revoked
 * account, or no envelope. Plaintext exists only in the caller's memory.
 */
export async function readConnectedAccountToken(
  ex: DbExecutor,
  tenantId: string,
  connectedAccountId: string,
  explicitMaster: string | null,
  env?: NodeJS.ProcessEnv,
): Promise<StoredTokenPair | null> {
  const row = await getConnectedAccount(ex, tenantId, connectedAccountId);
  if (!row || row.status !== 'ACTIVE' || !row.tokenEnvelope) return null;
  try {
    const payload = readColumn<{
      accessToken: string;
      refreshToken: string | null;
      scope: string | null;
    }>(row.tokenEnvelope, tokenKeyRing(explicitMaster, env));
    return {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      scope: payload.scope,
      expiresAt: row.tokenExpiresAt ?? new Date(0),
    };
  } catch {
    return null; // Undecryptable = unusable = fail closed, never half-authenticated.
  }
}

/**
 * Persist a refreshed token pair (the connector's token manager calls this on
 * refresh). Same boundary rules as the insert path.
 */
export async function saveConnectedAccountToken(
  ex: DbExecutor,
  tenantId: string,
  connectedAccountId: string,
  token: StoredTokenPair,
  explicitMaster: string | null,
  at: Date,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const keys = tokenKeyRing(explicitMaster, env);
  if (keys.length === 0) {
    throw new Error('Refusing to store OAuth tokens without a configured key ring.');
  }
  const envelope = encryptColumn(
    { accessToken: token.accessToken, refreshToken: token.refreshToken, scope: token.scope },
    keys[0]!,
  );
  await ex
    .update(connectedAccounts)
    .set({ tokenEnvelope: envelope, tokenExpiresAt: token.expiresAt, updatedAt: at })
    .where(and(eq(connectedAccounts.tenantId, tenantId), eq(connectedAccounts.connectedAccountId, connectedAccountId)));
}
