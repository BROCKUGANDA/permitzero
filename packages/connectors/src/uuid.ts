/**
 * Deterministic RFC 4122 v5 (name-based, SHA-1) UUIDs.
 *
 * Wise deduplicates transfer creation on `customerTransactionId`, so the id
 * sent for a given PermitZero idempotency key MUST be a pure function of that
 * key: two retries of one logical action produce one provider-side transfer,
 * and two different actions never share one. `crypto.randomUUID()` is random
 * and would break the first property; a plain hash is not a UUID and would be
 * rejected by providers that validate the shape.
 */
import { createHash } from 'node:crypto';

/** A namespace UUID generated once for PermitZero; any fixed value works. */
const PERMITZERO_NAMESPACE = 'a3b2c4d5-0000-4000-8000-0e1f2a3b4c5d';

export function uuidV5(name: string, namespace: string = PERMITZERO_NAMESPACE): string {
  const nsBytes = namespace
    .replace(/-/g, '')
    .match(/.{2}/g)!
    .map((h) => Number.parseInt(h, 16));
  const hash = createHash('sha1')
    .update(Buffer.from(Uint8Array.from(nsBytes)))
    .update(name, 'utf8')
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Set version 5 (name-based SHA-1) and the RFC 4122 variant bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
