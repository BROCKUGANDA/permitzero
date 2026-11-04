-- =============================================================================
-- PermitZero - 0011_mfa_last_used_step.sql
--
-- The 0008_mfa_totp migration added the last_used_step column, but some
-- databases were migrated before that column was added to the migration file.
-- This migration ensures the column exists on all databases.
-- =============================================================================

ALTER TABLE public.mfa_secrets
ADD COLUMN IF NOT EXISTS last_used_step bigint;

COMMENT ON COLUMN public.mfa_secrets.last_used_step IS
  'The TOTP step counter of the last accepted code. A code is accepted only when its step exceeds this value - otherwise a replayed or window-stale code from an earlier step could be accepted after a later step was used.';