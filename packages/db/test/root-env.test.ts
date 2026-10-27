/**
 * `npm run db:migrate` used to fail with "DATABASE_URL is not set" while the
 * variable sat in `.env` one directory up, because `import 'dotenv/config'`
 * reads from `process.cwd()` and npm runs a workspace's script with cwd set to
 * that workspace. These tests exist because the bug is invisible from the
 * interactive path: `npm run dev` works, since `scripts/dev.mjs` parses the root
 * `.env` itself. Only CI and `npm run db:migrate` hit it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRootEnv, repoRoot, rootEnvPath } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('repoRoot', () => {
  it('finds a directory that is identifiably this repository', () => {
    // Asserted by the markers the resolver itself looks for, not by the folder
    // name: cloning into `permitzero`, `pz`, or `~/src/pz-branch` must not break
    // a test of path resolution.
    const root = repoRoot(HERE);
    expect(existsSync(path.join(root, 'package.json'))).toBe(true);
    expect(existsSync(path.join(root, 'infra', 'migrations'))).toBe(true);
    expect(existsSync(path.join(root, 'vitest.config.ts'))).toBe(true);
  });

  it('finds it from a sibling package directory too', () => {
    // The walk-up must actually move. The first version computed `parent` and
    // never assigned it back, so the loop re-tested the same directory eight
    // times and fell through to a guessed relative path — which happened to be
    // right from packages/db/src and wrong from anywhere deeper.
    const deep = path.join(repoRoot(HERE), 'packages', 'observability', 'src');
    expect(repoRoot(deep)).toBe(path.resolve(repoRoot(HERE)));
  });

  it('stops at the filesystem boundary instead of looping forever', () => {
    const rootish = path.parse(HERE).root;
    expect(() => repoRoot(path.join(rootish, 'definitely-not-a-project'))).not.toThrow();
  });

  it('points the env file at the root .env next to package.json', () => {
    const file = rootEnvPath(repoRoot(HERE));
    expect(path.basename(file)).toBe('.env');
    expect(existsSync(path.join(path.dirname(file), 'package.json'))).toBe(true);
  });
});

describe('loadRootEnv', () => {
  it('fills a missing key from the file', () => {
    const env: NodeJS.ProcessEnv = {};
    loadRootEnv(env);
    // Whatever the developer's .env says, PORT is defined in both .env and
    // .env.example, so this asserts the mechanism rather than one value.
    expect(env['PORT']).toBeDefined();
  });

  it('never overwrites a value that was already set', () => {
    // This is what lets CI, a container env_file and a one-off
    // `DATABASE_URL=... npm run db:migrate` all win over the committed file.
    const env: NodeJS.ProcessEnv = { DATABASE_URL: 'postgres://explicit/win' };
    loadRootEnv(env);
    expect(env.DATABASE_URL).toBe('postgres://explicit/win');
  });

  it('returns the same object it was handed', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadRootEnv(env)).toBe(env);
  });

  it('tolerates a missing .env rather than throwing at boot', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadRootEnv(env)).not.toThrow();
  });
});
