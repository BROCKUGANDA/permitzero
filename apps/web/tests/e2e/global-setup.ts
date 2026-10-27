import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Global setup runs the seed script through the workspace tsx binary
 * directly (no shell, no npx): workspace packages ship TS source, and the
 * seed needs the tsx loader to import them.
 */
export default async function globalSetup(): Promise<void> {
  const webRoot = path.resolve(here, '..', '..');
  const require = createRequire(path.join(webRoot, 'package.json'));
  const tsxRoot = path.dirname(require.resolve('tsx/package.json'));
  const tsxCli = path.join(tsxRoot, 'dist', 'cli.mjs');
  await execFileAsync(process.execPath, [tsxCli, 'tests/e2e/seed-e2e.ts'], {
    cwd: webRoot,
    timeout: 180_000,
    env: { ...process.env },
  });
}
