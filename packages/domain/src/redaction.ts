/**
 * Redaction.
 *
 * PRD FR-074 / §8.5 and Master Prompt §5.14: no secrets, bearer tokens, full
 * bank details, raw private prompts or unredacted sensitive evidence may reach
 * logs, browser bundles or model inputs. Redaction is applied on the way *into*
 * every persisted `*_redacted` column and every log line, not on the way out.
 */

/** Key substrings that always force full redaction of the value. */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passphrase/i,
  /secret/i,
  /token/i,
  /apikey/i,
  /api_key/i,
  /authorization/i,
  /auth[_-]?header/i,
  /credential/i,
  /private[_-]?key/i,
  /signing[_-]?key/i,
  /session/i,
  /cookie/i,
  /bearer/i,
  /cvv/i,
  /cvc/i,
  /pan\b/i,
  /card[_-]?number/i,
  /account[_-]?number/i,
  /iban/i,
  /routing[_-]?number/i,
  /swift/i,
  /mnemonic/i,
  /seed[_-]?phrase/i,
];

/** Value shapes that are redacted regardless of the key they arrived under. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/, // JWT
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bglc_[A-Za-z0-9]{20,}\b/,
  /\bglsa_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Bank identifiers keep a prefix and suffix so an operator can still match them. */
const BANK_VALUE_PATTERNS: readonly RegExp[] = [
  /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/, // IBAN
  /\b\d{8,17}\b/, // generic long digit run: PAN or account number
];

export const REDACTED = '[REDACTED]';
export const MAX_REDACTION_DEPTH = 12;
export const MAX_REDACTED_STRING_LENGTH = 2048;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/** Mask a long digit run, keeping the last four for operator matching. */
export function maskAccountNumber(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 8) return REDACTED;
  return `••••${digits.slice(-4)}`;
}

function redactStringValue(value: string): string {
  if (SECRET_VALUE_PATTERNS.some((re) => re.test(value))) return REDACTED;
  let out = value;
  for (const re of BANK_VALUE_PATTERNS) {
    out = out.replace(re, (match) => {
      // Preserve short numbers that are legitimately part of an amount or ID.
      const digits = match.replace(/\D/g, '');
      if (digits.length < 8) return match;
      return maskAccountNumber(match);
    });
  }
  if (out.length > MAX_REDACTED_STRING_LENGTH) {
    return `${out.slice(0, MAX_REDACTED_STRING_LENGTH)}…[TRUNCATED]`;
  }
  return out;
}

/**
 * Deep-redact a value for safe persistence and logging. Returns a *new* object;
 * the input is never mutated, because the unredacted original is still needed to
 * compute the authoritative action hash.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) return '[DEPTH_LIMIT]';
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return redactStringValue(value as string);
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return '[UNSERIALIZABLE]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (t !== 'object') return REDACTED;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      // Keep the fact that the field existed; never its value.
      out[key] = child === null || child === undefined ? child : REDACTED;
      continue;
    }
    out[key] = redact(child, depth + 1);
  }
  return out;
}

/** Convenience for JSON columns. */
export function redactToJson(value: unknown): string {
  return JSON.stringify(redact(value) ?? null);
}

/**
 * Scrub a free-form log message. Structured fields should already be redacted;
 * this is the last line of defense for interpolated strings.
 */
export function scrubLogMessage(message: string): string {
  let out = message;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** Extract only the field names present, for evidence without content. */
export function fieldNames(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}
