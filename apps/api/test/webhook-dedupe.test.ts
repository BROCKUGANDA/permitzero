/**
 * A signed provider delivery must be deduplicated on the verified bytes, not
 * on the caller-supplied X-Delivery-Id. Otherwise one captured delivery can be
 * replayed under fresh ids and enqueue the same reconciliation repeatedly.
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, freshApp, type ApiFixture } from './helpers.js';

let fixture: ApiFixture | null = null;
afterEach(async () => {
  if (fixture) await closeApp(fixture);
  fixture = null;
});

const EVENT = JSON.stringify({
  event_type: 'transfers#state-change',
  schema_version: '4.0.0',
  data: { id: 16521632, status: 'outgoing_payment_sent' },
});

describe('Wise webhook replay', () => {
  it('treats a different delivery id with the same signed body as a duplicate', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    fixture = await freshApp({ config: { wiseWebhookPublicKey: publicPem } });
    const signature = createSign('SHA256').update(EVENT).sign(privateKey, 'base64');

    const send = (deliveryId: string) =>
      fixture!.app.inject({
        method: 'POST',
        url: '/v1/webhooks/wise',
        headers: {
          'content-type': 'application/json',
          'x-delivery-id': deliveryId,
          'x-signature-sha256': signature,
        },
        payload: EVENT,
      });

    const first = await send('delivery-one');
    const replay = await send('delivery-two');

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'duplicate' });
  });
});
