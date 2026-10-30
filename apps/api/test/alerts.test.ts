/**
 * The alert sink: the end of the alerting path.
 *
 * The sink exists because a firing rule that reaches nobody is not an
 * alerting system, and the deployed stack had a receiver whose URL was unset
 * by default. These tests pin the three things that matter about it: an
 * authenticated alert is accepted and recorded, an unauthenticated one is
 * refused, and the count of what arrived is visible in the metrics rather
 * than only in a log file nobody reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MetricsBundle } from '@permitzero/observability';
import { buildApp } from '../src/app.js';
import type { AppContext } from '../src/app.js';
import { createModelAdapter } from '../src/model.js';
import type { ApiConfig } from '../src/config.js';
import { testConfig, testDb, testRuntimeDb } from './helpers.js';

const ALERT_TOKEN = 'test-alert-ingest-token';

/**
 * The payload the Alertmanager posts.
 *
 * The shape of the real one, including the fields that are only present on
 * some alerts — a receiver that rejects a notification because the sender
 * added a field is a receiver that drops notifications.
 */
const FIRING_ALERT = {
  version: '4',
  groupKey: '{}:{alertname="PermitZeroAuditChainBroken"}',
  truncatedAlerts: 0,
  status: 'firing',
  receiver: 'webhook',
  groupLabels: { alertname: 'PermitZeroAuditChainBroken' },
  commonLabels: { alertname: 'PermitZeroAuditChainBroken', severity: 'page' },
  commonAnnotations: { summary: 'the audit chain does not verify' },
  externalURL: 'http://alertmanager:9093',
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'PermitZeroAuditChainBroken', severity: 'page' },
      annotations: { summary: 'the audit chain does not verify' },
      startsAt: '2026-10-29T09:00:00Z',
      endsAt: '0001-01-01T00:00:00Z',
      generatorURL: 'http://prometheus:9090/graph',
      fingerprint: 'a1b2c3d4',
    },
  ],
};

async function appWith(overrides: Partial<ApiConfig>): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const db = await testDb();
  const runtime = await testRuntimeDb();
  const built = await buildApp({
    db,
    dbRuntime: runtime,
    config: { ...testConfig(), ...overrides },
    model: createModelAdapter('disabled'),
  });
  return built;
}

function postAlert(
  app: FastifyInstance,
  body: unknown,
  headers: Record<string, string> = { 'x-alert-token': ALERT_TOKEN },
): Promise<{ status: number; json: unknown }> {
  return app
    .inject({
      method: 'POST',
      url: '/v1/internal/alerts',
      headers: { 'content-type': 'application/json', ...headers },
      payload: JSON.stringify(body),
    })
    .then((res) => ({ status: res.statusCode, json: res.json() as unknown }));
}

/** The value of one series of the alert counter. */
async function alertCount(metrics: MetricsBundle, outcome: string, severity: string): Promise<number> {
  const counter = await metrics.alertsReceived.get();
  return counter.values
    .filter((sample) => sample.labels['outcome'] === outcome && sample.labels['severity'] === severity)
    .reduce((sum, sample) => sum + sample.value, 0);
}

beforeAll(() => {
  // The sink's secret comes from the environment, the way the deployment sets
  // it. The route reads it per request, so setting it here is enough.
  process.env['ALERT_INGEST_TOKEN'] = ALERT_TOKEN;
});

afterAll(() => {
  delete process.env['ALERT_INGEST_TOKEN'];
});

describe('the alert sink', () => {
  it('accepts an authenticated alert and records it', async () => {
    const built = await appWith({});
    try {
      const res = await postAlert(built.app, FIRING_ALERT);
      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({ status: 'accepted', alerts: 1 });
      // And it is counted, so a sink that has stopped receiving is visible.
      expect(await alertCount(built.ctx.metrics, 'accepted', 'page')).toBe(1);
    } finally {
      await built.app.close();
    }
  });

  it('counts every alert in the notification, not every notification', async () => {
    const built = await appWith({});
    try {
      await postAlert(built.app, {
        ...FIRING_ALERT,
        alerts: [
          { ...FIRING_ALERT.alerts[0], labels: { alertname: 'One', severity: 'page' } },
          { ...FIRING_ALERT.alerts[0], labels: { alertname: 'Two', severity: 'ticket' } },
        ],
      });
      expect(await alertCount(built.ctx.metrics, 'accepted', 'page')).toBe(1);
      expect(await alertCount(built.ctx.metrics, 'accepted', 'ticket')).toBe(1);
    } finally {
      await built.app.close();
    }
  });

  it('refuses an alert with no token', async () => {
    const built = await appWith({});
    try {
      const res = await postAlert(built.app, FIRING_ALERT, {});
      expect(res.status).toBe(401);
      expect(res.json).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      // A refused notification is counted too: a sink that is receiving and
      // refusing is a different failure from a sink that is not receiving, and
      // the operator needs to be able to tell them apart.
      expect(await alertCount(built.ctx.metrics, 'rejected', 'unknown')).toBe(1);
      expect(await alertCount(built.ctx.metrics, 'accepted', 'page')).toBe(0);
    } finally {
      await built.app.close();
    }
  });

  it('refuses an alert with the wrong token', async () => {
    const built = await appWith({});
    try {
      const res = await postAlert(built.app, FIRING_ALERT, { 'x-alert-token': 'not-the-token' });
      expect(res.status).toBe(401);
      expect(res.json).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    } finally {
      await built.app.close();
    }
  });

  it('accepts the secret in the bearer carrier the pinned Alertmanager can send', async () => {
    const built = await appWith({});
    try {
      // The deployed Alertmanager (prom/alertmanager:v0.27.0) has no support
      // for custom headers at all, so the only credential it can carry is the
      // Authorization header. A sink that demanded a header nothing can send
      // would be a sink nothing reaches.
      const res = await postAlert(built.app, FIRING_ALERT, { authorization: `Bearer ${ALERT_TOKEN}` });
      expect(res.status).toBe(202);
    } finally {
      await built.app.close();
    }
  });

  it('exposes the count of what it received as a metric', async () => {
    const built = await appWith({});
    try {
      await postAlert(built.app, FIRING_ALERT);
      const exposition = await built.ctx.metrics.scrape();
      expect(exposition).toContain('pz_alerts_received_total');
      expect(exposition).toContain('outcome="accepted"');
    } finally {
      await built.app.close();
    }
  });

  it('is not charged against the credential budget, but is in the global limit', async () => {
    const built = await appWith({ rateLimitAuth: 1, rateLimitMax: 3 });
    try {
      // The sink presents the alerting secret rather than a tenant credential,
      // so the credential budget must not be charged against it — a flapping
      // rule must not be able to spend another caller's allowance.
      for (let i = 0; i < 3; i++) {
        const res = await postAlert(built.app, FIRING_ALERT, {
          'x-alert-token': ALERT_TOKEN,
          authorization: `Bearer ${ALERT_TOKEN}`,
        });
        expect(res.status).toBe(202);
      }
      // The global limit still applies: an endpoint that accepts a body from
      // anyone who can reach it is exactly what the global ceiling is for.
      const limited = await postAlert(built.app, FIRING_ALERT);
      expect(limited.status).toBe(429);
    } finally {
      await built.app.close();
    }
  });
});
