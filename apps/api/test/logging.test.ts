/**
 * Operational logging: is it on, does the configured level reach it, and does a
 * credential stay out of it.
 *
 * These tests exist because the app had `LOG_LEVEL` in `.env.example` while Fastify
 * ran with its logger disabled, so the one `request.log.error` in the error handler
 * wrote into a no-op. A control that is configured but not wired is the specific
 * thing an auditor cannot see from outside, so the assertions here are about the
 * running logger rather than about a config field existing.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loggerOptions, LOG_REDACT_PATHS } from '../src/app.js';
import { closeApp, freshApp, testConfig, type ApiFixture } from './helpers.js';

const SECRET_ENV = {
  DATABASE_URL: 'postgres://x@127.0.0.1:5432/pz',
  PERMIT_SIGNING_KEY: 'k'.repeat(32),
} as const;

describe('log level configuration', () => {
  it('takes the level from the environment', () => {
    const config = loadConfig({ ...process.env, ...SECRET_ENV, LOG_LEVEL: 'warn' });
    expect(config.logLevel).toBe('warn');
  });

  it('defaults to info rather than to silence', () => {
    const config = loadConfig({ ...process.env, ...SECRET_ENV, LOG_LEVEL: undefined });
    expect(config.logLevel).toBe('info');
  });

  it('refuses a level it does not understand, naming the variable', () => {
    // A typo that silently became "no logs" is the failure this guards: the
    // operator would have seen a clean boot and an empty log.
    expect(() => loadConfig({ ...process.env, ...SECRET_ENV, LOG_LEVEL: 'VERBOSE' })).toThrow(/LOG_LEVEL/);
  });

  it('maps the configured level onto the options the app is built with', () => {
    const options = loggerOptions({ ...testConfig(), logLevel: 'warn' });
    expect(options.level).toBe('warn');
    expect(options.redact.censor).toBe('[redacted]');
    expect(options.redact.paths).toContain('req.headers.authorization');
  });
});

describe('logger at the HTTP boundary', () => {
  let loud: ApiFixture;

  afterAll(async () => {
    if (loud) await closeApp(loud);
  });

  it('is actually enabled, at the configured level', async () => {
    loud = await freshApp({ config: { logLevel: 'info' } });
    // Fastify's disabled logger reports `fatal` with every method a no-op, so the
    // level is the observable difference between "logging configured" and "logging
    // wired up".
    expect(loud.app.log.level).toBe('info');
    expect(typeof loud.app.log.info).toBe('function');
  });

  it('builds an app with no logger noise at the test default', async () => {
    const quiet = await freshApp();
    try {
      expect(quiet.app.log.level).toBe('silent');
    } finally {
      await closeApp(quiet);
    }
  });

  it('redacts credential-shaped fields, and logs no headers by default', async () => {
    // What is asserted here, and what is not: pino writes to file descriptor 1
    // through its own sink rather than through `process.stdout.write`, so a test
    // cannot capture the app's log lines without replacing the logger production
    // wants. What the app's own logger instance does expose is its level (the test
    // above), and what the serializer shape decides is whether headers reach a line
    // at all: Fastify's default request serializer emits `{method,url,host,
    // remoteAddress}` — no headers — which is the reason a real bearer token was
    // never in these logs, and the reason the redact paths below are the second
    // line of defence for any handler that logs a header deliberately.
    expect(LOG_REDACT_PATHS).toContain('req.headers.authorization');
    const options = loggerOptions({ ...testConfig(), logLevel: 'info' });
    expect(options.redact.censor).toBe('[redacted]');

    // The serializer shape is the observable half: a request that carries a
    // credential must not have it in the response or in an error envelope either.
    const app = await freshApp({ config: { logLevel: 'warn' } });
    try {
      const res = await app.app.inject({
        method: 'POST',
        url: '/v1/actions',
        headers: { authorization: `Bearer ${app.agentToken}`, 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).not.toContain(app.agentToken);
    } finally {
      await closeApp(app);
    }
  });

  it('covers the header names this API accepts credentials through', () => {
    const paths = LOG_REDACT_PATHS.join(' ');
    for (const header of ['authorization', 'cookie', 'x-api-key']) {
      expect(paths, `${header} is accepted as a credential and must be redacted`).toContain(header);
    }
  });
});
