/**
 * Wise webhook helpers: signature verification and event extraction.
 *
 * Wise signs the RAW request body with its private key and sends the Base64
 * RSA-SHA256 signature in `X-Signature-SHA256`. Verification is only as good
 * as the bytes you feed it, so this module always works on the raw body —
 * never a re-serialized JSON object.
 *
 * Security posture: fail closed. A missing key, a bad signature, or a body
 * that does not parse means the delivery is rejected — Wise will retry, and
 * nothing is treated as true.
 */
import { createVerify } from 'node:crypto';

export class WiseWebhookError extends Error {
  readonly reason: 'SIGNATURE_INVALID' | 'BODY_NOT_JSON' | 'EVENT_NOT_STATE_CHANGE' | 'MISSING_DELIVERY_ID';

  constructor(message: string, reason: WiseWebhookError['reason']) {
    super(message);
    this.name = 'WiseWebhookError';
    this.reason = reason;
  }
}

/** Decode the PEM configured in the environment (accepts PEM or base64-wrapped PEM). */
export function decodeWiseWebhookPublicKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('-----BEGIN PUBLIC KEY-----')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf8').trim();
}

export function verifyWiseWebhookSignature(rawBody: Buffer, signatureBase64: string, publicKeyPem: string): void {
  let verified = false;
  try {
    const verifier = createVerify('SHA256');
    verifier.update(rawBody);
    verified = verifier.verify(publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new WiseWebhookError('The webhook signature did not verify.', 'SIGNATURE_INVALID');
  }
}

/** The fields the route cares about; everything else is ignored by design. */
export interface WiseStateChangeEvent {
  eventType: string;
  schemaVersion: string | null;
  subscriptionId: string | null;
  /** The provider's own transfer/payment id, whatever shape Wise chose. */
  providerRef: string;
  /** Wise transfer status, lowercase as sent. */
  status: string;
}

const PROVIDER_REF_KEYS = ['id', 'transfer_id', 'transferId', 'resource_id', 'transferResourceId'] as const;
const STATUS_KEYS = ['status', 'state', 'newState', 'currentState', 'current_state'] as const;

function findKey(node: unknown, keys: readonly string[], depth: number): unknown {
  if (depth > 4 || typeof node !== 'object' || node === null) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      const value = (node as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    const found = findKey(value, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Parse a `transfers#state-change` event. Throws WiseWebhookError on anything
 * that is not that event shape.
 */
export function parseWiseStateChangeEvent(rawBody: Buffer): WiseStateChangeEvent {
  let root: unknown;
  try {
    root = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new WiseWebhookError('The webhook body is not JSON.', 'BODY_NOT_JSON');
  }
  if (typeof root !== 'object' || root === null) {
    throw new WiseWebhookError('The webhook body is not an object.', 'BODY_NOT_JSON');
  }
  const record = root as Record<string, unknown>;
  const eventType = typeof record['event_type'] === 'string' ? record['event_type'] : null;
  if (eventType !== 'transfers#state-change') {
    throw new WiseWebhookError(
      `Event ${String(eventType ?? 'unknown')} is not a transfer state change.`,
      'EVENT_NOT_STATE_CHANGE',
    );
  }
  const providerRef = findKey(root, PROVIDER_REF_KEYS, 0);
  if (typeof providerRef !== 'string') {
    throw new WiseWebhookError('The state-change event carries no provider reference.', 'BODY_NOT_JSON');
  }
  const status = findKey(root, STATUS_KEYS, 0);
  return {
    eventType,
    schemaVersion: typeof record['schema_version'] === 'string' ? record['schema_version'] : null,
    subscriptionId: typeof record['subscription_id'] === 'string' ? record['subscription_id'] : null,
    providerRef,
    status: typeof status === 'string' ? status.toLowerCase() : 'unknown',
  };
}
