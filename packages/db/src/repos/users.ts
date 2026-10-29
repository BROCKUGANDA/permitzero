/**
 * MFA secret storage: the encrypted TOTP shared secret of an account, the
 * moment it last completed a step-up verification, and the account-level
 * marker that says the enrolment was confirmed.
 *
 * Two markers, on purpose. `mfa_secrets` exists from the moment an enrolment
 * STARTS, and `users.mfa_enrolled_at` is set only when it is CONFIRMED — a
 * person who has been handed a secret but has not yet proved they can produce
 * a code from it has not enrolled. The first says "a secret is stored"; the
 * second says "the person proved it".
 *
 * The secret row is tenant-scoped, and the tenant is the one the enrolment
 * happened in: an account belongs to a tenant, and the row is read and
 * written inside that tenant's transaction.
 */
import { and, eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { mfaSecrets, users } from '../schema.js';
import type { MfaSecretRow } from '../schema.js';

async function first<T>(rows: Promise<T[]>): Promise<T | null> {
  const [row] = await rows;
  return row ?? null;
}

/** The secret row of this user in this tenant, if there is one. */
export async function getMfaSecretByUserId(
  ex: DbExecutor,
  tenantId: string,
  userId: string,
): Promise<MfaSecretRow | null> {
  return first(
    ex
      .select()
      .from(mfaSecrets)
      .where(and(eq(mfaSecrets.tenantId, tenantId), eq(mfaSecrets.userId, userId)))
      .limit(1),
  );
}

/**
 * Store a secret for this user, replacing any previous one.
 *
 * An upsert rather than an insert, because re-enrolling is a legitimate act:
 * a person who lost their phone enrols again and the old secret must stop
 * working at once, not when they remember to remove it. The replacement
 * clears the verification timestamp too — the new secret has proved nothing
 * yet, and a step-up window carried over from the old secret would be a
 * verification of a secret nobody holds.
 */
export async function upsertMfaSecret(
  ex: DbExecutor,
  input: { id: string; tenantId: string; userId: string; secretEncrypted: string; now: Date },
): Promise<MfaSecretRow> {
  const [row] = await ex
    .insert(mfaSecrets)
    .values({
      id: input.id,
      tenantId: input.tenantId,
      userId: input.userId,
      secretEncrypted: input.secretEncrypted,
      createdAt: input.now,
    })
    .onConflictDoUpdate({
      target: mfaSecrets.userId,
      set: {
        secretEncrypted: input.secretEncrypted,
        createdAt: input.now,
        lastVerifiedAt: null,
        lastCodeHash: null,
      },
    })
    .returning();
  if (!row) throw new Error('mfa secret upsert returned no row');
  return row;
}

/** Remove the secret row of this user in this tenant. */
export async function deleteMfaSecret(ex: DbExecutor, tenantId: string, userId: string): Promise<void> {
  await ex.delete(mfaSecrets).where(and(eq(mfaSecrets.tenantId, tenantId), eq(mfaSecrets.userId, userId)));
}

/**
 * Record that this account just completed a step-up verification.
 *
 * The code fingerprint goes in with it: the code has been spent, and the next
 * presentation of the same code has to be refused. Returns false when there
 * is no secret row to record against, which means the account is not
 * enrolled and the caller must not go on to treat it as if it were.
 */
export async function recordMfaVerification(
  ex: DbExecutor,
  tenantId: string,
  userId: string,
  input: { now: Date; codeHash: string },
): Promise<boolean> {
  const rows = await ex
    .update(mfaSecrets)
    .set({ lastVerifiedAt: input.now, lastCodeHash: input.codeHash })
    .where(and(eq(mfaSecrets.tenantId, tenantId), eq(mfaSecrets.userId, userId)))
    .returning({ lastVerifiedAt: mfaSecrets.lastVerifiedAt });
  return rows.length > 0;
}

/**
 * Record that a TOTP code was spent, without recording a verification.
 *
 * Confirming an enrolment spends a code too, and it has to be spent
 * exactly once — but confirming is not a step-up verification, so it must not
 * write `last_verified_at`: that column answers "when did this person last
 * prove they are there", and a person who has just enrolled has not.
 */
export async function recordConsumedMfaCode(
  ex: DbExecutor,
  tenantId: string,
  userId: string,
  codeHash: string,
): Promise<boolean> {
  const rows = await ex
    .update(mfaSecrets)
    .set({ lastCodeHash: codeHash })
    .where(and(eq(mfaSecrets.tenantId, tenantId), eq(mfaSecrets.userId, userId)))
    .returning({ lastCodeHash: mfaSecrets.lastCodeHash });
  return rows.length > 0;
}

/**
 * When this account completed its MFA enrolment, if it has.
 *
 * The marker lives on the global user row rather than on the tenant-scoped
 * secret row, so it answers "is this person enrolled?" without depending on
 * which tenant the enrolment happened under.
 */
export async function getUserMfaEnrolledAt(ex: DbExecutor, userId: string): Promise<Date | null> {
  const row = await first(
    ex.select({ mfaEnrolledAt: users.mfaEnrolledAt }).from(users).where(eq(users.id, userId)).limit(1),
  );
  return row?.mfaEnrolledAt ?? null;
}

/**
 * Set or clear the enrolment marker.
 *
 * `users` is a global table: it has no tenant column, and the runtime role
 * may READ it for the members of the current tenant but may not WRITE it —
 * migration 0007 closed that path for a reason. What 0008 re-opens is exactly
 * one column, `mfa_enrolled_at`, and only for a transaction scoped to a
 * tenant the account belongs to; a trigger in the same migration refuses
 * every other column. `null` clears the marker, which is what a fresh
 * enrolment does: the new secret has proved nothing yet.
 */
export async function setUserMfaEnrolledAt(ex: DbExecutor, userId: string, at: Date | null): Promise<boolean> {
  const rows = await ex
    .update(users)
    .set({ mfaEnrolledAt: at })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return rows.length > 0;
}
