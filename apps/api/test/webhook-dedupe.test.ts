/**
 * The inbound Wise webhook is a live-provider surface and must not be present
 * in the simulation-only release, even if a verification key is configured.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, freshApp, type ApiFixture } from './helpers.js';

let fixture: ApiFixture | null = null;
afterEach(async () => {
  if (fixture) await closeApp(fixture);
  fixture = null;
});

describe('simulation-only provider boundary', () => {
  it('does not register the Wise webhook route even with a public key', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    fixture = await freshApp({ config: { wiseWebhookPublicKey: publicPem } });

    const res = await fixture.app.inject({
      method: 'POST',
      url: '/v1/webhooks/wise',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });
});
