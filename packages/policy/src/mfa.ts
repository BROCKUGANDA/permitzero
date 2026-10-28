/**
 * Server-issued MFA step-up assertions.
 *
 * A step-up assertion is a signed statement that "this principal completed
 * step-up authentication for this action, at this time". The server issues it
 * when a step-up is performed and verifies it before an approval that requires
 * MFA is accepted.
 *
 * Why this is not a client-supplied string: `require_mfa` used to be satisfied
 * by any non-empty `mfa_context_ref`, so the control was a field the caller
 * filled in — a caller who wanted to bypass it had to type one character. The
 * assertion below carries the server's signature over the subject, the action
 * and the expiry, so a client can present one but cannot manufacture one.
 *
 * Binding is deliberately narrow: tenant, principal, action and a short
 * expiry. An assertion for one approval cannot be replayed for another, and it
 * cannot outlive the moment it was issued.
 *
 * The signature is HMAC-SHA256 over the encoded payload and is compared in
 * constant time. The key is derived from the server secret with domain
 * separation, so forging an audit-chain entry and forging a step-up assertion
 * are not the same capability.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MFA_ASSERTION_PREFIX = 'pzmfa';
export const MFA_ASSERTION_VERSION = 1;

/**
 * How long an assertion stays usable. Step-up is a moment, not a session: an
 * assertion that is still valid an hour later is a credential, not a step-up.
 */
export const MFA_ASSERTION_TTL_SECONDS = 300;

export interface MfaAssertionPayload {
  v: number;
  tenantId: string;
  actorId: string;
  actionId: string;
  /** Epoch milliseconds. */
  issuedAt: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Makes two assertions for the same action distinguishable. */
  nonce: string;
}

export type MfaVerificationFailure =
  'MALFORMED' | 'UNSUPPORTED_VERSION' | 'BAD_SIGNATURE' | 'NOT_YET_VALID' | 'EXPIRED' | 'SUBJECT_MISMATCH';

export type MfaVerification =
  { ok: true; assertion: MfaAssertionPayload } | { ok: false; reason: MfaVerificationFailure };

export interface MfaExpectation {
  tenantId: string;
  actorId: string;
  actionId: string;
  /** The instant the assertion is judged against. */
  now: Date;
}

function encode(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function sign(payload: string, key: Buffer): string {
  return encode(createHmac('sha256', key).update(payload, 'utf8').digest());
}

/**
 * The assertion key, derived from the server secret rather than being that
 * secret. Domain separation is the point: one server secret must not be a
 * single capability, and a signature made with this key says nothing about an
 * audit chain signed with the raw secret.
 */
export function deriveMfaAssertionKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('permitzero/mfa-assertion/v1', 'utf8').digest();
}

/**
 * Issue an assertion. The caller is the server, at the moment a step-up was
 * actually performed — there is no way for a client to reach this function,
 * which is the entire point of the mechanism.
 */
export function issueMfaAssertion(
  payload: {
    tenantId: string;
    actorId: string;
    actionId: string;
    issuedAt: number;
    expiresAt: number;
    nonce?: string;
  },
  key: Buffer,
): string {
  const assertion: MfaAssertionPayload = {
    v: MFA_ASSERTION_VERSION,
    tenantId: payload.tenantId,
    actorId: payload.actorId,
    actionId: payload.actionId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce ?? randomBytes(8).toString('base64url'),
  };
  const encoded = encode(Buffer.from(JSON.stringify(assertion), 'utf8'));
  return `${MFA_ASSERTION_PREFIX}.${encoded}.${sign(encoded, key)}`;
}

/**
 * Verify an assertion against the subject it is expected to cover.
 *
 * Every failure mode is a refusal: a malformed token, a signature that does
 * not verify, a token issued in the future, an expired token, and a token that
 * is valid but belongs to another tenant, another principal or another action.
 * There is no "close enough" branch — a step-up is either this principal's
 * step-up for this action, or it is nothing.
 */
export function verifyMfaAssertion(token: string, key: Buffer, expected: MfaExpectation): MfaVerification {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== MFA_ASSERTION_PREFIX) return { ok: false, reason: 'MALFORMED' };
  const encoded = parts[1] ?? '';
  const provided = Buffer.from(parts[2] ?? '', 'base64url');
  const computed = Buffer.from(sign(encoded, key), 'base64url');
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'MALFORMED' };
  const assertion = parsed as MfaAssertionPayload;
  if (assertion.v !== MFA_ASSERTION_VERSION) return { ok: false, reason: 'UNSUPPORTED_VERSION' };
  const now = expected.now.getTime();
  if (!Number.isFinite(now)) return { ok: false, reason: 'MALFORMED' };
  if (!Number.isFinite(assertion.issuedAt) || !Number.isFinite(assertion.expiresAt)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (now < assertion.issuedAt) return { ok: false, reason: 'NOT_YET_VALID' };
  if (now >= assertion.expiresAt) return { ok: false, reason: 'EXPIRED' };
  if (
    assertion.tenantId !== expected.tenantId ||
    assertion.actorId !== expected.actorId ||
    assertion.actionId !== expected.actionId
  ) {
    return { ok: false, reason: 'SUBJECT_MISMATCH' };
  }
  return { ok: true, assertion };
}
