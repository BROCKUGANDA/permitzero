/**
 * Single-use, action-bound execution permits.
 *
 * A permit is an opaque token (`pzpt_<base64url nonce>`) issued after a
 * durable ALLOW/APPROVED decision. It binds tenant, agent, action, exact
 * argument hash, policy revision, audience tool, expiry and nonce. The raw
 * token is never persisted — only an HMAC (lookup) and a nonce hash
 * (binding proof). Verification is all-or-nothing: any mismatch fails closed
 * with a typed reason, never an exception.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DenyReason, hashEquals, newId } from '@permitzero/domain';
import type { DenyReason as DenyReasonType, PermitRecord } from '@permitzero/domain';
import { systemClock } from './ports.js';
import type { Clock, PermitStore, PersistedPermit } from './ports.js';

export interface PermitIssueInput {
  tenantId: string;
  agentId: string;
  actionId: string;
  actionHash: string;
  policyRevisionId: string;
  audienceTool: string;
  ttlSeconds: number;
}

export interface IssuedPermit {
  permitId: string;
  /** Opaque single-use token. Returned exactly once; never logged or stored raw. */
  token: string;
  nonceHash: string;
  issuedAt: Date;
  expiresAt: Date;
  signatureKeyId: string;
}

export interface PermitServiceConfig {
  signingKey: string;
  signingKeyId: string;
  store: PermitStore;
  clock?: Clock;
}

export interface PermitVerifyContext {
  tenantId: string;
  actionId: string;
  actionHash: string;
  policyRevisionId: string;
  audienceTool: string;
  now: Date;
}

export type PermitVerification =
  | { ok: true; permit: PermitRecord; nonce: string }
  | { ok: false; reason: DenyReasonType; detail: string };

const TOKEN_PREFIX = 'pzpt_';
const NONCE_BYTES = 32;
/** 43 base64url chars encode 32 bytes with no padding. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Defense in depth: permits are short-lived by design (PRD FR-031). */
const MAX_TTL_SECONDS = 3600;

function hmacHex(key: string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

function shaHex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function parseToken(token: unknown): string | null {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const body = token.slice(TOKEN_PREFIX.length);
  return NONCE_PATTERN.test(body) ? body : null;
}

function toPermitRecord(row: PersistedPermit): PermitRecord {
  return {
    permitId: row.permitId,
    tenantId: row.tenantId,
    actionId: row.actionId,
    actionHash: row.actionHash,
    policyRevisionId: row.policyRevisionId,
    audienceTool: row.audienceTool,
    nonceHash: row.nonceHash,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    revokedAt: row.revokedAt,
    signatureKeyId: row.signatureKeyId,
  };
}

export class PermitService {
  private readonly signingKey: string;
  private readonly signingKeyId: string;
  private readonly store: PermitStore;
  private readonly clock: Clock;

  constructor(config: PermitServiceConfig) {
    if (typeof config.signingKey !== 'string' || config.signingKey.length < 16) {
      throw new Error('PermitService requires a signing key of at least 16 characters.');
    }
    if (typeof config.signingKeyId !== 'string' || config.signingKeyId.length === 0) {
      throw new Error('PermitService requires a signing key id.');
    }
    this.signingKey = config.signingKey;
    this.signingKeyId = config.signingKeyId;
    this.store = config.store;
    this.clock = config.clock ?? systemClock;
  }

  async issue(input: PermitIssueInput): Promise<IssuedPermit> {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0 || input.ttlSeconds > MAX_TTL_SECONDS) {
      throw new RangeError(`Permit TTL must be an integer within 1..${MAX_TTL_SECONDS} seconds.`);
    }
    const issuedAt = this.clock();
    const expiresAt = new Date(issuedAt.getTime() + input.ttlSeconds * 1000);
    const nonce = randomBytes(NONCE_BYTES);
    const token = `${TOKEN_PREFIX}${nonce.toString('base64url')}`;
    const row: PersistedPermit = {
      permitId: newId('permit'),
      tenantId: input.tenantId,
      actionId: input.actionId,
      actionHash: input.actionHash,
      policyRevisionId: input.policyRevisionId,
      audienceTool: input.audienceTool,
      nonceHash: shaHex(nonce),
      issuedAt,
      expiresAt,
      consumedAt: null,
      revokedAt: null,
      signatureKeyId: this.signingKeyId,
      tokenHash: hmacHex(this.signingKey, token),
      revokeReason: null,
      version: 0,
    };
    await this.store.insert(row);
    return {
      permitId: row.permitId,
      token,
      nonceHash: row.nonceHash,
      issuedAt,
      expiresAt,
      signatureKeyId: this.signingKeyId,
    };
  }

  /**
   * Verify every binding, then consume atomically. Returns a typed rejection
   * for any invalid permit; only operational failures (store errors) throw.
   */
  async verifyAndConsume(token: string, context: PermitVerifyContext): Promise<PermitVerification> {
    if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) {
      throw new TypeError('Permit verification requires a valid clock reading.');
    }
    const fail = (reason: DenyReasonType, detail: string): PermitVerification => ({ ok: false, reason, detail });

    const nonceB64 = parseToken(token);
    if (nonceB64 === null) {
      // Deliberately the same reason as "unknown token": the format is opaque
      // and callers must not learn which half was wrong.
      return fail(DenyReason.PERMIT_MISSING, 'This permit was not recognized. It may be mistyped or from another system.');
    }
    const nonce = Buffer.from(nonceB64, 'base64url');
    if (nonce.length !== NONCE_BYTES) {
      return fail(DenyReason.PERMIT_MISSING, 'This permit was not recognized. It may be mistyped or from another system.');
    }

    const tokenHash = hmacHex(this.signingKey, token);
    const row = await this.store.findByTokenHash(tokenHash, context.tenantId);
    if (!row) {
      if (this.store.findByTokenHashCrossTenant) {
        const cross = await this.store.findByTokenHashCrossTenant(tokenHash);
        if (cross) {
          return fail(
            DenyReason.PERMIT_TENANT_MISMATCH,
            'This permit was issued for a different tenant and cannot be used here.',
          );
        }
      }
      return fail(DenyReason.PERMIT_MISSING, 'No such permit exists in this tenant. It may have expired or never been issued.');
    }

    if (row.revokedAt !== null) return fail(DenyReason.PERMIT_REVOKED, 'This permit was revoked by an operator.');
    if (row.consumedAt !== null) {
      return fail(DenyReason.PERMIT_CONSUMED, 'This permit was already used. Permits are single-use; request a fresh evaluation.');
    }
    if (context.now.getTime() >= row.expiresAt.getTime()) {
      return fail(DenyReason.PERMIT_EXPIRED, 'This permit has expired. Request a fresh evaluation.');
    }
    if (row.signatureKeyId !== this.signingKeyId) {
      return fail(DenyReason.PERMIT_SIGNATURE_INVALID, 'This permit was signed by an unknown key.');
    }
    if (!safeEqualHex(shaHex(nonce), row.nonceHash)) {
      return fail(DenyReason.PERMIT_NONCE_MISMATCH, 'This permit failed integrity verification.');
    }
    if (row.actionId !== context.actionId) {
      return fail(DenyReason.PERMIT_ACTION_MISMATCH, 'This permit was issued for a different action.');
    }
    if (!hashEquals(row.actionHash, context.actionHash)) {
      return fail(
        DenyReason.PERMIT_HASH_MISMATCH,
        'The approved action changed after approval. It must be reviewed again.',
      );
    }
    if (row.policyRevisionId !== context.policyRevisionId) {
      return fail(
        DenyReason.PERMIT_POLICY_REVISION_MISMATCH,
        'Policy changed after this permit was issued. The action must be evaluated again.',
      );
    }
    if (row.audienceTool !== context.audienceTool) {
      return fail(DenyReason.PERMIT_AUDIENCE_MISMATCH, 'This permit was issued for a different tool.');
    }

    const consumed = await this.store.consumeIfUnused(row.permitId, context.tenantId, context.now);
    if (!consumed.consumed || consumed.row === null) {
      return fail(DenyReason.PERMIT_CONSUMED, 'This permit was already used. Permits are single-use; request a fresh evaluation.');
    }
    return { ok: true, permit: toPermitRecord(consumed.row), nonce: nonceB64 };
  }

  /** Best-effort idempotent revoke: already-consumed permits are left alone. */
  async revoke(permitId: string, tenantId: string, reason: string): Promise<void> {
    await this.store.revoke(permitId, tenantId, reason, this.clock());
  }

  async revokeByAction(actionId: string, tenantId: string, reason: string): Promise<void> {
    await this.store.revokeByAction(actionId, tenantId, reason, this.clock());
  }
}
