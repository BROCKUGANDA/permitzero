/**
 * Request authentication. A bearer token resolves to a tenant-scoped
 * principal; the tenant always comes from the credential row, never from the
 * request body (FR-001). Secrets are compared by hash only — the raw token
 * is never logged, persisted or echoed.
 */
import { createHash } from 'node:crypto';
import { ForbiddenError, Role, UnauthenticatedError } from '@permitzero/domain';
import type { ActionRecord, Principal } from '@permitzero/domain';
import {
  findCredentialBySecretHash,
  getAgent,
  getMembership,
  getTenantById,
  getUserById,
  touchCredentialLastUsed,
} from '@permitzero/db';
import type { DbExecutor } from '@permitzero/db';

function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseBearer(header: string | undefined): string {
  if (typeof header !== 'string') throw new UnauthenticatedError();
  const match = /^Bearer (.+)$/.exec(header.trim());
  const token = match?.[1]?.trim() ?? '';
  if (token.length < 16) throw new UnauthenticatedError();
  return token;
}

/** Resolve the Authorization header to a principal, or throw 401/403. */
export async function authenticateToken(ex: DbExecutor, header: string | undefined, now: Date): Promise<Principal> {
  const token = parseBearer(header);
  const credential = await findCredentialBySecretHash(ex, sha256hex(token));
  if (!credential || credential.status !== 'ACTIVE') {
    // One message for "unknown" and "revoked": callers must not learn which.
    throw new UnauthenticatedError();
  }
  if (credential.expiresAt !== null && credential.expiresAt.getTime() <= now.getTime()) {
    throw new UnauthenticatedError('This credential has expired.');
  }

  // Usage accounting must never fail the request it describes.
  const touched = touchCredentialLastUsed(ex, credential.tenantId, credential.credentialId, now).catch(
    (err: unknown) => {
      console.error(
        `credential usage update failed for ${credential.credentialId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  );

  try {
    switch (credential.subjectType) {
      case 'AGENT': {
        if (!credential.subjectId) throw new UnauthenticatedError();
        const agent = await getAgent(ex, credential.tenantId, credential.subjectId);
        if (!agent || agent.status !== 'ACTIVE') throw new UnauthenticatedError();
        return {
          actorType: 'AGENT',
          actorId: agent.agentId,
          tenantId: credential.tenantId,
          roles: [],
          environment: agent.environment,
          displayName: agent.name,
          agentId: agent.agentId,
          credentialId: credential.credentialId,
          credentialExpiresAt: credential.expiresAt,
          mfaVerifiedAt: null,
        };
      }
      case 'USER': {
        if (!credential.subjectId) throw new UnauthenticatedError();
        const user = await getUserById(ex, credential.subjectId);
        if (!user || user.status !== 'ACTIVE') throw new UnauthenticatedError();
        const membership = await getMembership(ex, credential.tenantId, user.id);
        if (!membership) {
          throw new ForbiddenError('This account has no membership in the credential tenant.');
        }
        const tenant = await getTenantById(ex, credential.tenantId);
        return {
          actorType: 'USER',
          actorId: user.id,
          tenantId: credential.tenantId,
          roles: [membership.role],
          environment: tenant?.defaultEnvironment ?? 'DEMO',
          displayName: user.displayName,
          agentId: null,
          credentialId: credential.credentialId,
          credentialExpiresAt: credential.expiresAt,
          mfaVerifiedAt: null,
        };
      }
      case 'SERVICE': {
        const tenant = await getTenantById(ex, credential.tenantId);
        return {
          actorType: 'WORKER',
          actorId: `service:${credential.credentialId}`,
          tenantId: credential.tenantId,
          roles: [Role.SERVICE_AGENT],
          environment: tenant?.defaultEnvironment ?? 'DEMO',
          displayName: credential.name,
          agentId: null,
          credentialId: credential.credentialId,
          credentialExpiresAt: credential.expiresAt,
          mfaVerifiedAt: null,
        };
      }
      default:
        throw new UnauthenticatedError();
    }
  } finally {
    await touched;
  }
}

export function requireRoles(principal: Principal, ...roles: (typeof Role)[keyof typeof Role][]): void {
  if (!roles.some((r) => principal.roles.includes(r))) {
    throw new ForbiddenError('This action requires a different role.');
  }
}

/** Humans who may approve: owners and approvers, never agents or services. */
export function canApprove(principal: Principal): boolean {
  return principal.actorType === 'USER' && principal.roles.some((r) => r === Role.OWNER || r === Role.APPROVER);
}

export function requireApprover(principal: Principal): void {
  if (!canApprove(principal)) {
    throw new ForbiddenError('Approvals require a human approver account.');
  }
}

/** Who may spend a permit: the owning agent, an operator-grade human, or a service. */
export function canExecuteFor(principal: Principal, action: ActionRecord): boolean {
  if (principal.actorType === 'WORKER') return true;
  if (principal.actorType === 'AGENT') return principal.agentId === action.agentId;
  if (principal.actorType === 'USER') {
    return principal.roles.some((r) => r === Role.OWNER || r === Role.OPERATOR || r === Role.APPROVER);
  }
  return false;
}

export function requireExecute(principal: Principal, action: ActionRecord): void {
  if (!canExecuteFor(principal, action)) {
    throw new ForbiddenError('This identity may not execute this action.');
  }
}
