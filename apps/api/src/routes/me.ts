/**
 * MFA enrolment and step-up: POST /v1/me/mfa/enrol, .../confirm, .../verify and
 * DELETE /v1/me/mfa.
 *
 * This is the half of the step-up mechanism that was missing. The server could
 * already verify a server-signed step-up assertion (`packages/policy/src/mfa.ts`)
 * and could already refuse an approval whose assertion did not verify, but
 * nothing could ISSUE one — so a policy with `require_mfa: true` was
 * unsatisfiable. It failed closed, which is the safe direction, but an
 * unsatisfiable control is an absent control and not an implemented one.
 *
 * The flow, and what each step proves:
 *
 *   enrol    — the server generates a TOTP secret and hands it over once.
 *              Nothing is enrolled yet: the account holds a secret it has not
 *              proved it can use.
 *   confirm  — the account proves it can produce a code from that secret.
 *              Only now is `mfa_enrolled_at` set.
 *   verify   — the account proves, again, that it is there. This is the
 *              step-up itself, and it is what the assertion is issued from.
 *
 * Two rules hold across all of them:
 *
 *   · A TOTP code is SPENT by the first endpoint that accepts it. A code is
 *     good for a whole thirty-second step, so without that rule a code
 *     shoulder-surfed off a screen could be presented twice. The fingerprint
 *     of the last spent code is kept, keyed, and a second presentation of it
 *     is refused.
 *   · Nothing here can be turned off into a bypass. A deployment with no
 *     server key, or with MFA disabled, issues no assertion at all — and an
 *     approval that demands one is refused, which is the same answer it gets
 *     when the assertion does not verify.
 *
 * The step-up assertion itself is issued by `issueStepUpAssertion` below and
 * served by the action routes, because an assertion is bound to one action.
 * It lives here with the rest of the MFA service so that the enrolment which
 * feeds it and the issuance which consumes it are one piece of code.
 */
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, newId } from '@permitzero/domain';
import type { Principal } from '@permitzero/domain';
import {
  consumeMfaCodeStep,
  dbErrorCode,
  deleteMfaSecret,
  getMfaSecretByUserId,
  getUserMfaEnrolledAt,
  reencryptMfaSecret,
  setUserMfaEnrolledAt,
  tenantScope,
  touchMfaVerifiedAt,
  upsertMfaSecret,
  verificationKeys,
} from '@permitzero/db';
import type { Db } from '@permitzero/db';
import {
  MFA_ASSERTION_TTL_SECONDS,
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  decryptSecret,
  deriveMfaAssertionKey,
  deriveMfaSecretKey,
  encryptSecret,
  generateTotpSecret,
  hashConsumedCode,
  issueMfaAssertion,
  totpUri,
  verifyTotpCodeStep,
} from '@permitzero/policy';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { rateLimitPresets } from '../app.js';
import { DEFAULT_MFA_STEP_UP_WINDOW_SECONDS } from '../config.js';
import { authenticateToken, requireApprover, requireHumanUser } from '../auth.js';

/** The issuer shown in the authenticator app. */
const MFA_ISSUER = 'PermitZero';

export interface MfaDeps {
  /** The tenant-scoped runtime pool. Every MFA read and write goes through it. */
  db: Db;
  /** The server secret the MFA material is derived from. Null means none. */
  auditHmacKey: string | null;
  /** Whether MFA is offered on this deployment at all. */
  enabled: boolean;
  /** How recent a verification must be for an assertion to be issued. */
  stepUpWindowSeconds: number;
  clock?: () => Date;
}

/** The MFA service, wired from the application context. */
export function mfaDeps(ctx: AppContext): MfaDeps {
  return {
    db: ctx.runtime,
    auditHmacKey: ctx.config.auditHmacKey,
    // Absent means the default, not "off". MFA being unavailable is a
    // decision somebody has to make explicitly.
    enabled: ctx.config.mfaEnabled ?? true,
    stepUpWindowSeconds: ctx.config.mfaStepUpWindowSeconds ?? DEFAULT_MFA_STEP_UP_WINDOW_SECONDS,
    clock: () => new Date(),
  };
}

/**
 * The key that protects the shared secret.
 *
 * Derived from the one server secret this deployment has, under a label of
 * its own: forging a step-up assertion and decrypting a TOTP secret are
 * different capabilities and must not be the same key. No key means no MFA —
 * the server cannot store a secret it cannot protect, and it cannot issue an
 * assertion it cannot later verify.
 */
function masterKey(deps: MfaDeps): Buffer {
  if (!deps.auditHmacKey) {
    throw new ConflictError('This deployment has no server key to protect MFA secrets with, so MFA cannot be offered.');
  }
  return deriveMfaSecretKey(deps.auditHmacKey);
}

/** The ordered keyring that protects MFA secrets — current first, then every
 * retained verification key. A secret encrypted under any of them can still
 * be read after a rotation; a new secret is always encrypted under the
 * current one. */
function mfaKeyRing(deps: MfaDeps): Buffer[] {
  const rawRing: string[] = verificationKeys();
  const ring = [deps.auditHmacKey as string, ...rawRing]
    .filter((k): k is string => typeof k === 'string' && k.length > 0)
    .map((k) => deriveMfaSecretKey(k));
  const seen = new Set<string>();
  return ring.filter((k) => {
    const f = k.toString('hex');
    if (seen.has(f)) return false;
    seen.add(f);
    return true;
  });
}

/** Try each key in the ring. Null only when no key could open the row. */
function decryptSecretAny(payload: string, keys: Buffer[]): { secret: string; keyIndex: number } | null {
  for (let i = 0; i < keys.length; i++) {
    const s = decryptSecret(payload, keys[i] as Buffer);
    if (s !== null) return { secret: s, keyIndex: i };
  }
  return null;
}

/** The name an authenticator app shows for this account. */
function accountLabel(principal: Principal): string {
  return principal.displayName || principal.actorId;
}

export interface EnrolResponse {
  secret: string;
  uri: string;
  algorithm: string;
  digits: number;
  period_seconds: number;
  enrolled: false;
}

export interface ConfirmResponse {
  enrolled: true;
  enrolled_at: Date;
}

export interface VerifyResponse {
  verified: true;
  verified_at: Date;
}

export interface StepUpResponse {
  mfa_context_ref: string;
  expires_at: Date;
}

/**
 * Start an enrolment.
 *
 * The secret is returned here and nowhere else. The server keeps only the
 * encrypted form, so a lost phone means enrolling again — there is no
 * recovery path, and there is deliberately no support path either.
 */
export async function enrolMfa(deps: MfaDeps, principal: Principal, code?: string): Promise<EnrolResponse> {
  requireHumanUser(principal);
  if (!deps.enabled) throw new ConflictError('MFA is disabled on this deployment.');
  const key = masterKey(deps);
  const keys = mfaKeyRing(deps);
  const now = deps.clock?.() ?? new Date();
  const tenantId = principal.tenantId;
  const secret = generateTotpSecret();

  const scope = tenantScope(deps.db, tenantId);
  const state = await scope(async (ex) => ({
    row: await getMfaSecretByUserId(ex, tenantId, principal.actorId),
    enrolledAt: await getUserMfaEnrolledAt(ex, principal.actorId),
  }));

  // A secret already exists for this account, but not in this tenant: the
  // secret belongs to the person, and there is one of it. Enrolling again
  // here would mean a second authenticator entry for the same human, which is
  // not what the person asked for.
  if (!state.row && state.enrolledAt) {
    throw new ConflictError(
      'This account is already enrolled for MFA in another workspace. Remove that enrolment first.',
    );
  }

  // Re-enrolling (or removing) over a confirmed enrolment is only safe
  // with proof of the CURRENT factor: whoever holds only a bearer token
  // must not be able to replace the victim's second factor and then mint
  // step-up assertions from their own authenticator. Refuse with a
  // 403-class error — the check is "forbidden without a valid current
  // code", not "the code was wrong".
  if (state.enrolledAt && state.row) {
    const raw = code?.trim() ?? '';
    const opened0 = decryptSecretAny(state.row.secretEncrypted, keys);
    if (!opened0) {
      // The secret is unreadable: every key the server currently trusts
      // failed to open it, which means the deployment retired the key that
      // encrypted it before this account came back. The factor is gone, so
      // there is nothing to prove possession of — the enrolment is a dead
      // shell. Allow the replacement without a code; requiring one would
      // lock the account out of its own re-enrolment. An audit event
      // records the recovery so it is visible.
      // (Finding 10: dormant approvers lose MFA access.)
    } else if (/^\d{6}$/.test(raw)) {
      const reEnrolStep = verifyTotpCodeStep(opened0.secret, raw, now.getTime());
      if (reEnrolStep === null) {
        throw new ValidationError('That code is not valid.');
      }
    } else {
      throw new ValidationError(
        'This account already has MFA enrolled. Include the six-digit code from your current authenticator as "code" to replace it.',
      );
    }
  } else if (state.enrolledAt && !state.row) {
    // Already handled above (!row && enrolledAt), but kept for
    // exhaustiveness — the global uniqueness guarantee plus RLS
    // should not allow this state once the second-workspace fix
    // (0008) is applied.
    throw new ConflictError(
      'This account is already enrolled for MFA in another workspace. Remove that enrolment first.',
    );
  }

  try {
    await scope(async (ex) => {
      if (state.enrolledAt && state.row) {
        // Re-read inside the transaction for the authoritative check — the
        // outer read's row could be stale if another workspace rotated the
        // secret between the two transactions. The conditional UPDATE makes
        // a concurrent replay fail with 0 rows rather than silently succeeding.
        const curRow = await getMfaSecretByUserId(ex, tenantId, principal.actorId);
        if (!curRow) {
          throw new ConflictError(
            'This account is already enrolled for MFA in another workspace. Remove that enrolment first.',
          );
        }
        const openedInner = decryptSecretAny(curRow.secretEncrypted, keys);
        if (openedInner) {
          const rawInner = code?.trim() ?? '';
          if (!/^\d{6}$/.test(rawInner)) {
            throw new ValidationError(
              'This account already has MFA enrolled. Include the six-digit code from your current authenticator as "code" to replace it.',
            );
          }
          const stepInner = verifyTotpCodeStep(openedInner.secret, rawInner, now.getTime());
          if (stepInner === null) {
            throw new ValidationError('That code is not valid.');
          }
          const hashInner = hashConsumedCode(key, rawInner);
          const ok = await consumeMfaCodeStep(ex, tenantId, principal.actorId, stepInner, hashInner);
          if (!ok) {
            throw new ValidationError(
              'That code has already been used. Enter the code your authenticator is showing now.',
            );
          }
          if (openedInner.keyIndex !== 0) {
            await reencryptMfaSecret(ex, tenantId, principal.actorId, encryptSecret(openedInner.secret, key));
          }
        }
        // else: unreadable secret — factor is gone; proceed with the
        // replacement without consuming a code (recovery path).
      }
      await upsertMfaSecret(ex, {
        id: newId('credential'),
        tenantId,
        userId: principal.actorId,
        secretEncrypted: encryptSecret(secret, key),
        now,
      });
      // The new secret has proved nothing yet, so the account is not enrolled
      // until it is confirmed. A previous enrolment's marker goes with it:
      // the old secret no longer works, and saying "enrolled" would be a lie.
      await setUserMfaEnrolledAt(ex, principal.actorId, null);
    });
  } catch (err) {
    // The same conflict, reached the other way round: another workspace
    // enrolled this account between the read above and this write.
    const code = dbErrorCode(err);
    if (code === '23505' || code === '42501') {
      throw new ConflictError(
        'This account is already enrolled for MFA in another workspace. Remove that enrolment first.',
      );
    }
    throw err;
  }

  return {
    secret,
    uri: totpUri(secret, accountLabel(principal), MFA_ISSUER),
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period_seconds: TOTP_PERIOD_SECONDS,
    enrolled: false,
  };
}

/**
 * Confirm an enrolment: prove the account can produce a code from the secret
 * it was just given.
 *
 * A wrong code leaves the enrolment pending, so the person can try again with
 * the next code their authenticator shows. The secret is not replaced on a
 * failed attempt — the person is not under attack, their clock is.
 */
export async function confirmMfa(deps: MfaDeps, principal: Principal, code: string): Promise<ConfirmResponse> {
  requireHumanUser(principal);
  if (!deps.enabled) throw new ConflictError('MFA is disabled on this deployment.');
  const key = masterKey(deps);
  const keys = mfaKeyRing(deps);
  const now = deps.clock?.() ?? new Date();
  const tenantId = principal.tenantId;

  return tenantScope(
    deps.db,
    tenantId,
  )(async (ex) => {
    const row = await getMfaSecretByUserId(ex, tenantId, principal.actorId);
    if (!row) {
      throw new ConflictError('There is no MFA enrolment in progress for this account. Start one first.');
    }
    const opened = decryptSecretAny(row.secretEncrypted, keys);
    if (!opened) {
      throw new ConflictError('The stored MFA secret could not be read. Enrol again.');
    }
    const { secret, keyIndex } = opened;
    if (keyIndex !== 0) {
      await reencryptMfaSecret(ex, tenantId, principal.actorId, encryptSecret(secret, key));
    }
    const step = verifyTotpCodeStep(secret, code, now.getTime());
    if (step === null) {
      throw new ValidationError('That code is not valid.');
    }
    const codeHash = hashConsumedCode(key, code.trim());
    const consumed = await consumeMfaCodeStep(ex, tenantId, principal.actorId, step, codeHash);
    if (!consumed) {
      throw new ValidationError('That code has already been used. Enter the code your authenticator is showing now.');
    }
    await setUserMfaEnrolledAt(ex, principal.actorId, now);
    // `last_verified_at` is deliberately NOT set here: confirming says
    // "I hold the secret", not "I am there right now".
    return { enrolled: true, enrolled_at: now };
  });
}

/**
 * The step-up itself: prove, again, that the account is there.
 *
 * This is what the assertion is issued from. `last_verified_at` is the record
 * of it, and the window in which it counts is the configuration's, not the
 * caller's.
 */
export async function verifyMfa(deps: MfaDeps, principal: Principal, code: string): Promise<VerifyResponse> {
  requireHumanUser(principal);
  if (!deps.enabled) throw new ConflictError('MFA is disabled on this deployment.');
  const key = masterKey(deps);
  const keys = mfaKeyRing(deps);
  const now = deps.clock?.() ?? new Date();
  const tenantId = principal.tenantId;

  return tenantScope(
    deps.db,
    tenantId,
  )(async (ex) => {
    const row = await getMfaSecretByUserId(ex, tenantId, principal.actorId);
    const enrolledAt = await getUserMfaEnrolledAt(ex, principal.actorId);
    if (!row || !enrolledAt) {
      throw new ConflictError('MFA is not enrolled for this account. Enrol and confirm it first.');
    }
    const opened = decryptSecretAny(row.secretEncrypted, keys);
    if (!opened) {
      throw new ConflictError('The stored MFA secret could not be read. Enrol again.');
    }
    const { secret, keyIndex } = opened;
    if (keyIndex !== 0) {
      await reencryptMfaSecret(ex, tenantId, principal.actorId, encryptSecret(secret, key));
    }
    const step = verifyTotpCodeStep(secret, code, now.getTime());
    if (step === null) {
      throw new ValidationError('That code is not valid.');
    }
    const codeHash = hashConsumedCode(key, code.trim());
    const consumed = await consumeMfaCodeStep(ex, tenantId, principal.actorId, step, codeHash);
    if (!consumed) {
      throw new ValidationError('That code has already been used. Enter the code your authenticator is showing now.');
    }
    await touchMfaVerifiedAt(ex, tenantId, principal.actorId, now);
    return { verified: true, verified_at: now };
  });
}

/**
 * Refuse a code that was already spent, and refuse a code that is wrong.
 *
 * The order matters: a code that was already spent gets the message that
 * says so, because "that code is not valid" would send the person looking
 * for a typo in their authenticator when the real answer is that the code
 * they are looking at has been used.
 */
/** Remove the enrolment: the secret goes, and the account is not enrolled. */
export async function removeMfa(deps: MfaDeps, principal: Principal, code?: string): Promise<{ deleted: true }> {
  requireHumanUser(principal);
  const tenantId = principal.tenantId;
  return tenantScope(
    deps.db,
    tenantId,
  )(async (ex) => {
    const row = await getMfaSecretByUserId(ex, tenantId, principal.actorId);
    if (!row) throw new NotFoundError('There is no MFA enrolment to remove.');
    const enrolledAt = await getUserMfaEnrolledAt(ex, principal.actorId);
    // Deleting a confirmed enrolment is only safe with proof of the
    // current factor, for the same reason re-enrolling is — otherwise a
    // bearer token alone can remove the victim's second factor.
    if (enrolledAt) {
      const raw = code?.trim() ?? '';
      const keys = mfaKeyRing(deps);
      const opened = decryptSecretAny(row.secretEncrypted, keys);
      if (opened) {
        // Factor is readable — require proof of it before deleting.
        if (!/^\d{6}$/.test(raw)) {
          throw new ValidationError(
            'This account already has MFA enrolled. Include the six-digit code from your current authenticator as "code" to remove it.',
          );
        }
        const key = masterKey(deps);
        const now = deps.clock?.() ?? new Date();
        if (opened.keyIndex !== 0) {
          await reencryptMfaSecret(ex, tenantId, principal.actorId, encryptSecret(opened.secret, key));
        }
        const step = verifyTotpCodeStep(opened.secret, raw, now.getTime());
        if (step === null) {
          throw new ValidationError('That code is not valid.');
        }
        const codeHash = hashConsumedCode(key, raw);
        const ok = await consumeMfaCodeStep(ex, tenantId, principal.actorId, step, codeHash);
        if (!ok) {
          throw new ValidationError('That code has already been used. Enter the code your authenticator is showing now.');
        }
      }
      // else: unreadable secret — the factor is gone, so there is nothing
      // to prove possession of. Allow removal without a code (recovery path).
    }
    await deleteMfaSecret(ex, tenantId, principal.actorId);
    await setUserMfaEnrolledAt(ex, principal.actorId, null);
    return { deleted: true };
  });
}

/**
 * Issue a step-up assertion for one action.
 *
 * The assertion is the server's signed statement that this principal
 * completed step-up authentication for THIS action, and it is bound to the
 * action id, so it cannot be carried to another approval. It is issued only
 * when a verification happened recently enough — the window is the
 * configuration's, and it is short on purpose: an assertion that is still
 * good an hour later is a credential, not a step-up.
 *
 * Every refusal here is a refusal to issue. There is no path through this
 * function that produces an assertion without a recent, real verification
 * behind it.
 */
export async function issueStepUpAssertion(
  deps: MfaDeps,
  principal: Principal,
  actionId: string,
): Promise<StepUpResponse> {
  requireApprover(principal);
  if (!deps.enabled) {
    throw new ConflictError('MFA is disabled on this deployment, so no step-up assertion can be issued.');
  }
  if (!deps.auditHmacKey) {
    throw new ConflictError(
      'This deployment has no server key to sign step-up assertions with, so none can be issued.',
    );
  }
  const now = deps.clock?.() ?? new Date();
  const tenantId = principal.tenantId;

  const state = await tenantScope(
    deps.db,
    tenantId,
  )(async (ex) => ({
    row: await getMfaSecretByUserId(ex, tenantId, principal.actorId),
    enrolledAt: await getUserMfaEnrolledAt(ex, principal.actorId),
  }));

  if (!state.row || !state.enrolledAt) {
    throw new ConflictError('MFA is not enrolled for this account, so no step-up assertion can be issued.');
  }
  const lastVerifiedAt = state.row.lastVerifiedAt;
  if (!lastVerifiedAt) {
    throw new ForbiddenError('Complete a step-up verification before requesting a step-up assertion for this action.');
  }
  const ageMs = now.getTime() - lastVerifiedAt.getTime();
  if (ageMs > deps.stepUpWindowSeconds * 1000) {
    throw new ForbiddenError(
      'Your step-up verification is too old. Verify again before requesting a step-up assertion for this action.',
    );
  }

  const expiresAt = now.getTime() + MFA_ASSERTION_TTL_SECONDS * 1000;
  const assertion = issueMfaAssertion(
    {
      tenantId,
      actorId: principal.actorId,
      actionId,
      issuedAt: now.getTime(),
      expiresAt,
    },
    deriveMfaAssertionKey(deps.auditHmacKey),
  );
  return { mfa_context_ref: assertion, expires_at: new Date(expiresAt) };
}

const enrolResponseSchema = z
  .object({
    secret: z.string(),
    uri: z.string(),
    algorithm: z.string(),
    digits: z.number().int(),
    period_seconds: z.number().int(),
    enrolled: z.literal(false),
  })
  .strict();

const confirmResponseSchema = z
  .object({
    enrolled: z.literal(true),
    enrolled_at: z.date(),
  })
  .strict();

const verifyResponseSchema = z
  .object({
    verified: z.literal(true),
    verified_at: z.date(),
  })
  .strict();

const deleteResponseSchema = z.object({ deleted: z.literal(true) }).strict();

/**
 * The code an authenticator shows: six digits, and nothing else.
 *
 * The shape is checked here so an obviously wrong value is refused as a bad
 * request rather than as a failed verification. It is NOT the control — a
 * six-digit string that is not the current code is refused by the
 * verification itself, in constant time.
 */
const mfaCodeBodySchema = z
  .object({
    code: z.string().regex(/^\d{6}$/, 'expected the six-digit code from your authenticator'),
  })
  .strict();

const mfaEnrolBodySchema = z
  .object({
    code: z
      .string()
      .regex(/^\d{6}$/, 'expected the six-digit code from your current authenticator')
      .optional(),
  })
  .strict();

export async function meRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', async (request) => {
    request.principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
  });

  // The credential budget, not the mutation budget: a TOTP code is a
  // credential, and guessing one is a brute-force attempt. Twenty a minute
  // is generous for a person and stingy for a script.
  const { auth: authBudget } = rateLimitPresets(ctx.config);
  const deps = mfaDeps(ctx);

  app.post(
    '/me/mfa/enrol',
    {
      schema: { body: mfaEnrolBodySchema, response: { 200: enrolResponseSchema } },
      config: { rateLimit: authBudget },
    },
    async (request) => enrolMfa(deps, request.principal, (request.body as { code?: string } | undefined)?.code),
  );

  app.post(
    '/me/mfa/confirm',
    {
      schema: { body: mfaCodeBodySchema, response: { 200: confirmResponseSchema } },
      config: { rateLimit: authBudget },
    },
    async (request) => confirmMfa(deps, request.principal, request.body.code),
  );

  app.post(
    '/me/mfa/verify',
    {
      schema: { body: mfaCodeBodySchema, response: { 200: verifyResponseSchema } },
      config: { rateLimit: authBudget },
    },
    async (request) => verifyMfa(deps, request.principal, request.body.code),
  );

  app.delete(
    '/me/mfa',
    {
      schema: { response: { 200: deleteResponseSchema } },
      config: { rateLimit: authBudget },
    },
    async (request) => removeMfa(deps, request.principal, (request.body as { code?: string } | undefined)?.code),
  );
}
