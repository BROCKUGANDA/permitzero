/**
 * Locate and load the repository's `.env` regardless of the current directory.
 *
 * `import 'dotenv/config'` reads `.env` from `process.cwd()`, which is not the
 * repository root for any of the ways this project is actually started:
 *
 *   · `npm run db:migrate` — npm runs a workspace's lifecycle script with cwd
 *     set to that workspace, so cwd is `packages/db` and `.env` is not found;
 *   · the same for `start:api`, `start:worker` and `model:check`;
 *   · `scripts/dev.mjs` — the one path that works, because it parses the root
 *     `.env` itself and hands the values to its children.
 *
 * The consequence was a command that succeeds interactively and fails in CI
 * with "DATABASE_URL is not set", for a variable that is plainly in the file.
 * Resolving the path from this module's own location rather than from cwd makes
 * the answer the same everywhere, which is the same reasoning
 * `DEFAULT_MIGRATIONS_DIR` in `client.ts` already uses.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/** Absolute path of the repository root, walked up from this file. */
export function repoRoot(startDir: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'infra'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '../../..');
}

export function rootEnvPath(root: string = repoRoot()): string {
  return path.join(root, '.env');
}

/**
 * Load the root `.env` into `process.env` without letting it overwrite anything
 * already set, so an explicit environment (CI, a container env file, a one-off
 * `DATABASE_URL=... npm run ...`) always wins over the file.
 */
export function loadRootEnv(overrides: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const file = rootEnvPath();
  if (existsSync(file)) {
    const parsed = dotenv.parse(readFileSync(file));
    for (const [key, value] of Object.entries(parsed)) {
      if (overrides[key] === undefined) overrides[key] = value;
    }
  }
  return overrides;
}
