/**
 * Outbox router: known informational events acknowledge, anything else goes
 * to the dead-letter path with a name, never silently dropped.
 */
import { describe, expect, it } from 'vitest';
import type { QueueJob } from '@permitzero/queue';
import { createOutboxRouter } from '../src/handlers/outbox-events.js';

function job(name: string, data: unknown): QueueJob {
  return {
    id: 'job_1',
    name,
    queue: 'pz.outbox',
    data,
    attempt: 1,
    tenantId: 'ten_test',
    traceId: null,
  };
}

describe('outbox router', () => {
  it.each(['action.decided', 'action.approved', 'action.rejected', 'action.expired'])(
    'acknowledges %s',
    async (event) => {
      const handler = createOutboxRouter();
      const result = await handler(job(event, { outboxId: 'obx_1', tenantId: 'ten_test', eventType: event }));
      expect(result).toEqual({ outcome: 'DONE' });
    },
  );

  it('dead-letters unknown events', async () => {
    const handler = createOutboxRouter();
    const result = await handler(job('billing.exploded', { outboxId: 'obx_1', tenantId: 'ten_test' }));
    expect(result).toEqual({ outcome: 'FAILED', errorClass: 'UNKNOWN_EVENT_TYPE' });
  });

  it('dead-letters malformed envelopes', async () => {
    const handler = createOutboxRouter();
    expect(await handler(job('action.decided', { tenantId: 'ten_test' }))).toEqual({
      outcome: 'FAILED',
      errorClass: 'INVALID_JOB_PAYLOAD',
    });
    const noTenant = job('action.decided', { outboxId: 'obx_1' });
    noTenant.tenantId = null;
    expect(await handler(noTenant)).toEqual({
      outcome: 'FAILED',
      errorClass: 'INVALID_JOB_PAYLOAD',
    });
    expect(await handler(job('action.decided', 'not-an-object'))).toEqual({
      outcome: 'FAILED',
      errorClass: 'INVALID_JOB_PAYLOAD',
    });
  });

  it('accepts the tenant from the job envelope', async () => {
    const handler = createOutboxRouter();
    // BullMQ jobs carry tenantId top-level; data without it still routes.
    expect(await handler(job('action.decided', { outboxId: 'obx_1' }))).toEqual({ outcome: 'DONE' });
  });
});
