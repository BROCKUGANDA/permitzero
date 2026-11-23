/**
 * Wise webhook helpers: RSA-SHA256 signature verification over the RAW bytes,
 * and state-change event extraction. Uses a throwaway keypair generated at
 * test time — no real provider material involved.
 */
import { generateKeyPairSync, createSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeWiseWebhookPublicKey,
  parseWiseStateChangeEvent,
  verifyWiseWebhookSignature,
  WiseWebhookError,
} from '../src/wise-webhook.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function signedBody(body: object): { raw: Buffer; signature: string } {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const signature = createSign('SHA256').update(raw).sign(privatePem, 'base64');
  return { raw, signature };
}

const STATE_CHANGE = {
  schema_version: '4.0.0',
  subscription_id: 'sub-1',
  event_type: 'transfers#state-change',
  data: { id: 16521632, status: 'outgoing_payment_sent' },
};

describe('Wise webhook verification', () => {
  it('accepts a correctly signed raw body', () => {
    const { raw, signature } = signedBody(STATE_CHANGE);
    expect(() => verifyWiseWebhookSignature(raw, signature, publicPem)).not.toThrow();
  });

  it('rejects a signature over different bytes', () => {
    const { raw, signature } = signedBody(STATE_CHANGE);
    const tampered = Buffer.from(raw.toString('utf8').replace('16521632', '99999999'), 'utf8');
    expect(() => verifyWiseWebhookSignature(tampered, signature, publicPem)).toThrow(WiseWebhookError);
  });

  it('rejects a signature from the wrong key', () => {
    const { raw } = signedBody(STATE_CHANGE);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const bad = createSign('SHA256').update(raw).sign(other.privateKey, 'base64');
    expect(() => verifyWiseWebhookSignature(raw, bad, publicPem)).toThrow(WiseWebhookError);
  });

  it('decodes a PEM passed through an env var unchanged or base64-wrapped', () => {
    expect(decodeWiseWebhookPublicKey(publicPem)).toBe(publicPem.trim());
    expect(decodeWiseWebhookPublicKey(Buffer.from(publicPem, 'utf8').toString('base64'))).toBe(publicPem.trim());
  });

  it('rejects an empty, malformed or wrong-algorithm signature without throwing a raw crypto error', () => {
    const { raw } = signedBody(STATE_CHANGE);
    for (const bad of ['', '!!!not base64!!!', 'YWJj']) {
      expect(() => verifyWiseWebhookSignature(raw, bad, publicPem)).toThrow(
        expect.objectContaining({ reason: 'SIGNATURE_INVALID' }),
      );
    }
  });

  it('requires the signature to be over the raw bytes, not a re-serialized object', () => {
    const { raw, signature } = signedBody(STATE_CHANGE);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8')), null, 2), 'utf8');
    expect(() => verifyWiseWebhookSignature(reserialized, signature, publicPem)).toThrow(WiseWebhookError);
  });
});

describe('Wise state-change parsing', () => {
  it('extracts the provider reference and status from the event', () => {
    const { raw } = signedBody(STATE_CHANGE);
    const event = parseWiseStateChangeEvent(raw);
    expect(event.eventType).toBe('transfers#state-change');
    expect(event.providerRef).toBe('16521632');
    expect(event.status).toBe('outgoing_payment_sent');
    expect(event.subscriptionId).toBe('sub-1');
  });

  it('tolerates a nested resource payload shape', () => {
    const { raw } = signedBody({
      event_type: 'transfers#state-change',
      data: { transfer_id: 'trf_778', currentState: 'processing' },
    });
    const event = parseWiseStateChangeEvent(raw);
    expect(event.providerRef).toBe('trf_778');
    expect(event.status).toBe('processing');
  });

  it('refuses non-state-change events and bodies without a reference', () => {
    expect(() => parseWiseStateChangeEvent(Buffer.from(JSON.stringify({ event_type: 'balance.moved' })))).toThrow(
      WiseWebhookError,
    );
    expect(() =>
      parseWiseStateChangeEvent(Buffer.from(JSON.stringify({ event_type: 'transfers#state-change', data: {} }))),
    ).toThrow(WiseWebhookError);
    expect(() => parseWiseStateChangeEvent(Buffer.from('not json'))).toThrow(WiseWebhookError);
  });

  it('strips case from the status and tolerates a missing one as unknown', () => {
    const withStatus = parseWiseStateChangeEvent(
      Buffer.from(JSON.stringify({ event_type: 'transfers#state-change', data: { id: 7, status: 'SENT' } })),
    );
    const without = parseWiseStateChangeEvent(
      Buffer.from(JSON.stringify({ event_type: 'transfers#state-change', data: { id: 8 } })),
    );
    expect(withStatus.status).toBe('sent');
    expect(without.status).toBe('unknown');
  });

  it('coerces a numeric provider reference but refuses one nested past the search depth', () => {
    const numeric = parseWiseStateChangeEvent(
      Buffer.from(JSON.stringify({ event_type: 'transfers#state-change', data: { id: 16521632 } })),
    );
    expect(numeric.providerRef).toBe('16521632');

    const buried: Record<string, unknown> = { event_type: 'transfers#state-change' };
    let cursor = buried;
    for (const level of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      cursor[level] = {};
      cursor = cursor[level] as Record<string, unknown>;
    }
    cursor['id'] = 'too-deep';
    expect(() => parseWiseStateChangeEvent(Buffer.from(JSON.stringify(buried)))).toThrow(WiseWebhookError);
  });
});
