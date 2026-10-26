/**
 * PermitService tests: issuance, single-use consumption, expiry, revocation,
 * binding checks and tenant isolation — all against in-memory stores.
 */
import { describe, expect, it } from 'vitest';
import { DenyReason } from '@permitzero/domain';
import { createMemoryStores } from '../src/memory-stores.js';
import { PermitService } from '../src/permits.js';
import type { PermitIssueInput } from '../src/permits.js';

const SIGNING_KEY = 'test-signing-key-0123456789abcdef';
const SIGNING_KEY_ID = 'test-key-v1';
const ACTION_HASH = `sha256:${'ab'.repeat(32)}`;

function setup() {
  const now = { t: new Date('2026-10-26T12:00:00Z').getTime() };
  const clock = () => new Date(now.t);
  const stores = createMemoryStores({ clock });
  const permits = new PermitService({ signingKey: SIGNING_KEY, signingKeyId: SIGNING_KEY_ID, store: stores.permits, clock });
  const input: PermitIssueInput = {
    tenantId: 'ten_test',
    agentId: 'agt_test',
    actionId: 'act_test',
    actionHash: ACTION_HASH,
    policyRevisionId: 'polrev_test',
    audienceTool: 'payment.execute',
    ttlSeconds: 60,
  };
  const context = (overrides = {}) => ({
    tenantId: 'ten_test',
    actionId: 'act_test',
    actionHash: ACTION_HASH,
    policyRevisionId: 'polrev_test',
    audienceTool: 'payment.execute',
    now: clock(),
    ...overrides,
  });
  return { stores, permits, input, context, advance: (ms: number) => { now.t += ms; } };
}

describe('PermitService', () => {
  it('issues and consumes a permit exactly once', async () => {
    const { permits, input, context } = setup();
    const issued = await permits.issue(input);
    expect(issued.token).toMatch(/^pzpt_[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt.getTime() - issued.issuedAt.getTime()).toBe(60_000);

    const first = await permits.verifyAndConsume(issued.token, context());
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.permit.permitId).toBe(issued.permitId);
      expect(first.permit.actionHash).toBe(ACTION_HASH);
      expect('token' in first.permit).toBe(false);
    }
    const second = await permits.verifyAndConsume(issued.token, context());
    expect(second).toMatchObject({ ok: false, reason: DenyReason.PERMIT_CONSUMED });
  });

  it('lets exactly one of two concurrent consumers win', async () => {
    const { permits, input, context } = setup();
    const issued = await permits.issue(input);
    const [a, b] = await Promise.all([
      permits.verifyAndConsume(issued.token, context()),
      permits.verifyAndConsume(issued.token, context()),
    ]);
    const oks = [a.ok, b.ok].filter(Boolean);
    expect(oks).toHaveLength(1);
  });

  it('rejects expired permits', async () => {
    const { permits, input, context, advance } = setup();
    const issued = await permits.issue(input);
    advance(60_001);
    const result = await permits.verifyAndConsume(issued.token, context());
    expect(result).toMatchObject({ ok: false, reason: DenyReason.PERMIT_EXPIRED });
  });

  it('rejects revoked permits and revokes by action', async () => {
    const { permits, input, context } = setup();
    const a = await permits.issue(input);
    const b = await permits.issue(input);
    await permits.revoke(a.permitId, 'ten_test', 'operator hold');
    expect(await permits.verifyAndConsume(a.token, context())).toMatchObject({
      ok: false,
      reason: DenyReason.PERMIT_REVOKED,
    });
    await permits.revokeByAction('act_test', 'ten_test', 'policy changed');
    expect(await permits.verifyAndConsume(b.token, context())).toMatchObject({
      ok: false,
      reason: DenyReason.PERMIT_REVOKED,
    });
  });

  it('does not recognize tampered or malformed tokens', async () => {
    const { permits, input, context } = setup();
    const issued = await permits.issue(input);
    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith('A') ? 'B' : 'A'}`;
    expect(await permits.verifyAndConsume(tampered, context())).toMatchObject({
      ok: false,
      reason: DenyReason.PERMIT_MISSING,
    });
    for (const bad of ['', 'pzpt_', 'pzpt_short', 'not-a-permit', 'pmt_act_something']) {
      expect(await permits.verifyAndConsume(bad, context())).toMatchObject({
        ok: false,
        reason: DenyReason.PERMIT_MISSING,
      });
    }
  });

  it('distinguishes cross-tenant presentation from a missing permit', async () => {
    const { permits, input, context } = setup();
    const issued = await permits.issue(input);
    const cross = await permits.verifyAndConsume(issued.token, context({ tenantId: 'ten_other' }));
    expect(cross).toMatchObject({ ok: false, reason: DenyReason.PERMIT_TENANT_MISMATCH });
  });

  it('reports missing when the store cannot check other tenants', async () => {
    const { stores, input, context } = setup();
    const narrow = new PermitService({
      signingKey: SIGNING_KEY,
      signingKeyId: SIGNING_KEY_ID,
      store: { ...stores.permits, findByTokenHashCrossTenant: undefined },
    });
    const issued = await narrow.issue(input);
    const result = await narrow.verifyAndConsume(issued.token, context({ tenantId: 'ten_other' }));
    expect(result).toMatchObject({ ok: false, reason: DenyReason.PERMIT_MISSING });
  });

  it('enforces every binding independently', async () => {
    const cases = [
      [{ actionId: 'act_other' }, DenyReason.PERMIT_ACTION_MISMATCH],
      [{ actionHash: `sha256:${'cd'.repeat(32)}` }, DenyReason.PERMIT_HASH_MISMATCH],
      [{ policyRevisionId: 'polrev_other' }, DenyReason.PERMIT_POLICY_REVISION_MISMATCH],
      [{ audienceTool: 'vendor.export' }, DenyReason.PERMIT_AUDIENCE_MISMATCH],
    ] as const;
    for (const [override, reason] of cases) {
      const { permits, input, context } = setup();
      const issued = await permits.issue(input);
      expect(await permits.verifyAndConsume(issued.token, context(override))).toMatchObject({ ok: false, reason });
    }
  });

  it('rejects permits signed by an unknown key id', async () => {
    const { stores, input, context } = setup();
    const other = new PermitService({
      signingKey: 'a-different-signing-key-0123456789',
      signingKeyId: 'other-key-v9',
      store: stores.permits,
    });
    // Same store, different service key: the HMAC lookup misses entirely.
    const issued = await other.issue(input);
    const main = new PermitService({ signingKey: SIGNING_KEY, signingKeyId: SIGNING_KEY_ID, store: stores.permits });
    expect(await main.verifyAndConsume(issued.token, context())).toMatchObject({
      ok: false,
      reason: DenyReason.PERMIT_MISSING,
    });
  });

  it('validates configuration and ttl at the boundary', async () => {
    const { stores } = setup();
    expect(() => new PermitService({ signingKey: 'short', signingKeyId: 'k', store: stores.permits })).toThrow();
    expect(() => new PermitService({ signingKey: SIGNING_KEY, signingKeyId: '', store: stores.permits })).toThrow();
    const permits = new PermitService({ signingKey: SIGNING_KEY, signingKeyId: SIGNING_KEY_ID, store: stores.permits });
    const base = {
      tenantId: 't',
      agentId: 'a',
      actionId: 'x',
      actionHash: ACTION_HASH,
      policyRevisionId: 'p',
      audienceTool: 'payment.execute',
    };
    await expect(permits.issue({ ...base, ttlSeconds: 0 })).rejects.toThrow(RangeError);
    await expect(permits.issue({ ...base, ttlSeconds: 3601 })).rejects.toThrow(RangeError);
    await expect(permits.verifyAndConsume('pzpt_' + 'A'.repeat(43), {
      tenantId: 't',
      actionId: 'x',
      actionHash: ACTION_HASH,
      policyRevisionId: 'p',
      audienceTool: 'payment.execute',
      now: new Date(Number.NaN),
    })).rejects.toThrow(TypeError);
  });
});
