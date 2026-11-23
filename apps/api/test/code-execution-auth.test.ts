/**
 * Code execution spawns an interpreter as the API's OS user. Authentication
 * alone must never be enough to reach it: the route is absent unless enabled,
 * and only tenant administrative principals may submit code.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, freshApp, postJson, type ApiFixture } from './helpers.js';

let fixture: ApiFixture | null = null;
afterEach(async () => {
  if (fixture) await closeApp(fixture);
  fixture = null;
});

describe('code execution exposure', () => {
  it('does not register the route when the capability is off', async () => {
    fixture = await freshApp();
    const res = await postJson(fixture, '/v1/code-execution/run', fixture.ownerToken, { code: 'ok', language: 'node' });
    expect(res.status).toBe(404);
  });

  it('lets an owner past authorization when the deployment opts in', async () => {
    fixture = await freshApp({ config: { codeExecutionEnabled: true } });
    // An empty body fails validation with 400 rather than authorization with
    // 403, which is enough to prove the gate admitted this principal without
    // spawning an interpreter in the test suite.
    const res = await postJson(fixture, '/v1/code-execution/run', fixture.ownerToken, {});
    expect(res.status).toBe(400);
  });

  it.each(['agentToken', 'auditorToken', 'serviceToken'] as const)(
    'refuses the %s credential even with the capability enabled',
    async (tokenKey) => {
      fixture = await freshApp({ config: { codeExecutionEnabled: true } });
      const res = await postJson(fixture, '/v1/code-execution/run', fixture[tokenKey], {
        code: 'ok',
        language: 'node',
      });
      expect(res.status).toBe(403);
    },
  );
});
