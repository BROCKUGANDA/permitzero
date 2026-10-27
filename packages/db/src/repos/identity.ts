/**
 * Identity repositories: tenants, users, memberships, service credentials and
 * agents. Every lookup is tenant-scoped except credential resolution by secret
 * hash (the hash itself is the lookup key; tenant scoping happens after).
 */
import { and, asc, eq } from 'drizzle-orm';
import type { AgentStatus, Environment, Role } from '@permitzero/domain';
import type { DbExecutor } from '../client.js';
import { agents, serviceCredentials, tenantMemberships, tenants, users } from '../schema.js';
import type { AgentRow, ServiceCredentialRow, TenantMembershipRow, TenantRow, UserRow } from '../schema.js';

async function first<T>(rows: Promise<T[]>): Promise<T | null> {
  const [row] = await rows;
  return row ?? null;
}

export async function createTenant(
  ex: DbExecutor,
  input: { id: string; name: string; slug: string; defaultEnvironment: Environment; synthetic?: boolean },
): Promise<TenantRow> {
  const [row] = await ex
    .insert(tenants)
    .values({
      id: input.id,
      name: input.name,
      slug: input.slug,
      defaultEnvironment: input.defaultEnvironment,
      synthetic: input.synthetic ?? false,
    })
    .returning();
  if (!row) throw new Error('tenant insert returned no row');
  return row;
}

export async function getTenantById(ex: DbExecutor, id: string): Promise<TenantRow | null> {
  return first(ex.select().from(tenants).where(eq(tenants.id, id)).limit(1));
}

export async function getTenantBySlug(ex: DbExecutor, slug: string): Promise<TenantRow | null> {
  return first(ex.select().from(tenants).where(eq(tenants.slug, slug)).limit(1));
}

/**
 * Every ACTIVE tenant id, oldest first.
 *
 * This is a cross-tenant read by necessity: it is how a background worker learns
 * which tenants to visit. It is therefore only ever issued from inside
 * `withTenantBlindTransaction`, where policy `door_lookup` permits SELECT on
 * `tenants` and on nothing that holds customer data. Sweeps then iterate these
 * ids and do their work tenant-scoped, which also means one busy tenant cannot
 * starve another of a sweep pass.
 */
export async function listActiveTenantIds(ex: DbExecutor): Promise<string[]> {
  const rows = await ex
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, 'ACTIVE'))
    .orderBy(asc(tenants.createdAt));
  return rows.map((r) => r.id);
}

export async function createUser(
  ex: DbExecutor,
  input: { id: string; email: string; displayName: string; status?: UserRow['status'] },
): Promise<UserRow> {
  const [row] = await ex
    .insert(users)
    .values({ id: input.id, email: input.email, displayName: input.displayName, status: input.status ?? 'ACTIVE' })
    .returning();
  if (!row) throw new Error('user insert returned no row');
  return row;
}

export async function getUserById(ex: DbExecutor, id: string): Promise<UserRow | null> {
  return first(ex.select().from(users).where(eq(users.id, id)).limit(1));
}

export async function createMembership(
  ex: DbExecutor,
  input: { id: string; tenantId: string; userId: string; role: Role },
): Promise<TenantMembershipRow> {
  const [row] = await ex
    .insert(tenantMemberships)
    .values({
      membershipId: input.id,
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
    })
    .returning();
  if (!row) throw new Error('membership insert returned no row');
  return row;
}

export async function getMembership(
  ex: DbExecutor,
  tenantId: string,
  userId: string,
): Promise<TenantMembershipRow | null> {
  return first(
    ex
      .select()
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)))
      .limit(1),
  );
}

export async function listMembershipsByUser(ex: DbExecutor, userId: string): Promise<TenantMembershipRow[]> {
  return ex.select().from(tenantMemberships).where(eq(tenantMemberships.userId, userId));
}

export async function createCredential(
  ex: DbExecutor,
  input: {
    id: string;
    tenantId: string;
    name: string;
    subjectType: ServiceCredentialRow['subjectType'];
    subjectId: string | null;
    credentialRef: string;
    secretHash: string;
    secretPrefix: string;
    scopes: readonly string[];
    status?: ServiceCredentialRow['status'];
    expiresAt?: Date | null;
  },
): Promise<ServiceCredentialRow> {
  const [row] = await ex
    .insert(serviceCredentials)
    .values({
      credentialId: input.id,
      tenantId: input.tenantId,
      name: input.name,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      credentialRef: input.credentialRef,
      secretHash: input.secretHash,
      secretPrefix: input.secretPrefix,
      scopesJson: [...input.scopes],
      status: input.status ?? 'ACTIVE',
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  if (!row) throw new Error('credential insert returned no row');
  return row;
}

/** Authentication lookup: exactly one row per secret hash, cross-tenant. */
export async function findCredentialBySecretHash(
  ex: DbExecutor,
  secretHash: string,
): Promise<ServiceCredentialRow | null> {
  return first(ex.select().from(serviceCredentials).where(eq(serviceCredentials.secretHash, secretHash)).limit(1));
}

export async function getCredentialById(
  ex: DbExecutor,
  tenantId: string,
  id: string,
): Promise<ServiceCredentialRow | null> {
  return first(
    ex
      .select()
      .from(serviceCredentials)
      .where(and(eq(serviceCredentials.tenantId, tenantId), eq(serviceCredentials.credentialId, id)))
      .limit(1),
  );
}

export async function revokeCredential(ex: DbExecutor, tenantId: string, id: string, now: Date): Promise<void> {
  await ex
    .update(serviceCredentials)
    .set({ status: 'REVOKED', revokedAt: now, updatedAt: now })
    .where(and(eq(serviceCredentials.tenantId, tenantId), eq(serviceCredentials.credentialId, id)));
}

export async function touchCredentialLastUsed(ex: DbExecutor, tenantId: string, id: string, now: Date): Promise<void> {
  await ex
    .update(serviceCredentials)
    .set({ lastUsedAt: now })
    .where(and(eq(serviceCredentials.tenantId, tenantId), eq(serviceCredentials.credentialId, id)));
}

export async function createAgent(
  ex: DbExecutor,
  input: {
    agentId: string;
    tenantId: string;
    name: string;
    framework: string;
    environment: Environment;
    status?: AgentStatus;
    credentialId: string;
    credentialExpiresAt?: Date | null;
    allowedTools: ReadonlyArray<{ toolName: string; operations: string[] }>;
  },
): Promise<AgentRow> {
  const [row] = await ex
    .insert(agents)
    .values({
      agentId: input.agentId,
      tenantId: input.tenantId,
      name: input.name,
      framework: input.framework,
      environment: input.environment,
      status: input.status ?? 'ACTIVE',
      credentialId: input.credentialId ?? null,
      credentialExpiresAt: input.credentialExpiresAt ?? null,
      allowedToolsJson: input.allowedTools.map((t) => ({ toolName: t.toolName, operations: [...t.operations] })),
    })
    .returning();
  if (!row) throw new Error('agent insert returned no row');
  return row;
}

export async function getAgent(ex: DbExecutor, tenantId: string, agentId: string): Promise<AgentRow | null> {
  return first(
    ex
      .select()
      .from(agents)
      .where(and(eq(agents.tenantId, tenantId), eq(agents.agentId, agentId)))
      .limit(1),
  );
}

export async function listAgents(ex: DbExecutor, tenantId: string): Promise<AgentRow[]> {
  return ex.select().from(agents).where(eq(agents.tenantId, tenantId));
}
