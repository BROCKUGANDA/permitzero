#!/usr/bin/env node
/**
 * scripts/dev.mjs — one command to run PermitZero locally.
 *
 * `npm run dev` pointed here from the first slice, but the file did not exist.
 *
 * What it does, in order:
 *   1. starts PostgreSQL and Redis through infra/docker-compose.yml
 *      (skipped with a clear message if Docker is absent — the app then needs
 *      a reachable DATABASE_URL from .env)
 *   2. waits for PostgreSQL to accept connections
 *   3. runs migrations, then the seed, which writes storage/demo-credentials.json
 *   4. starts api, worker and web together, prefixed, and tears all three down
 *      on Ctrl-C
 *
 * Ports: api 3100, web 3000. They match playwright.config.ts and the default
 * NEXT_PUBLIC_API_URL, so `npm run dev` and `npm run test:e2e` drive the same
 * wiring.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = ['compose', '-f', 'infra/docker-compose.yml'];
const API_PORT = process.env['API_PORT'] ?? '3100';
const WEB_PORT = process.env['WEB_PORT'] ?? '3000';

const say = (m) => console.log(`[dev] ${m}`);

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
}

function dockerAvailable() {
  const r = spawnSync('docker', ['version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return r.status === 0;
}

// --- .env -----------------------------------------------------------------
if (!existsSync(path.join(root, '.env'))) {
  if (existsSync(path.join(root, '.env.example'))) {
    copyFileSync(path.join(root, '.env.example'), path.join(root, '.env'));
    say('created .env from .env.example — fill in the signing keys before you trust anything it decides');
  } else {
    say('no .env and no .env.example; relying on ambient environment');
  }
}

const envFile = existsSync(path.join(root, '.env')) ? readFileSync(path.join(root, '.env'), 'utf8') : '';
const envValue = (name) => {
  const fromFile = envFile.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
  return process.env[name] || fromFile || '';
};

if (!envValue('PERMIT_SIGNING_KEY')) {
  say('PERMIT_SIGNING_KEY is empty. Generate one with:  node -e "console.log(require(\x27crypto\x27).randomBytes(32).toString(\x27hex\x27))"');
  process.exit(1);
}

// --- data tier ------------------------------------------------------------
let startedDeps = false;
if (dockerAvailable()) {
  say('starting postgres + redis');
  const r = run('docker', [...COMPOSE, 'up', '-d', 'postgres', 'redis']);
  if (r.status !== 0) {
    say('docker compose could not start the data tier; continuing on a reachable DATABASE_URL if you have one');
  } else {
    startedDeps = true;
  }
} else {
  say('Docker is not available — expecting postgres and redis to already be reachable');
}

if (startedDeps) {
  const url = envValue('DATABASE_URL') || 'postgres://permitzero@127.0.0.1:5432/permitzero';
  say(`waiting for the database`);
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt++) {
    const r = spawnSync(
      'node',
      [
        '-e',
        `import('postgres').then(({default:pg})=>{const sql=pg(${JSON.stringify(url)});sql\`select 1\`.then(()=>sql.end()).then(()=>process.exit(0)).catch(()=>process.exit(1))}).catch(()=>process.exit(1))`,
      ],
      { cwd: root, stdio: 'ignore' },
    );
    ready = r.status === 0;
    if (!ready) spawnSync('node', ['-e', 'setTimeout(()=>{},600)']);
  }
  if (!ready) {
    say('database never accepted connections');
    process.exit(1);
  }
}

// --- migrate + seed -------------------------------------------------------
say('migrating');
if (run('npm', ['run', 'db:migrate'], { env: { ...process.env, DATABASE_URL: envValue('DATABASE_URL') } }).status !== 0) {
  process.exit(1);
}
say('seeding synthetic demo data (refuses to run when APP_ENV=production)');
if (run('npm', ['run', 'db:seed'], { env: { ...process.env, DATABASE_URL: envValue('DATABASE_URL') } }).status !== 0) {
  process.exit(1);
}
say('demo bearer tokens for every role: storage/demo-credentials.json');

// --- app ------------------------------------------------------------------
const children = [];
const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[32m'];

function start(name, args, env, index) {
  const child = spawn('npm', args, {
    cwd: root,
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `${COLORS[index % COLORS.length]}[${name}]\x1b[0m`;
  const pipe = (stream) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        console.log(`${prefix} ${buf.slice(0, i)}`);
        buf = buf.slice(i + 1);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix} exited (${code})`);
  });
  children.push(child);
}

start('api ', ['run', 'dev:api'], { PORT: API_PORT, HOST: '127.0.0.1' }, 0);
start('wrkr', ['run', 'dev:worker'], {}, 1);
start('web ', ['run', 'dev:web'], { NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`, PORT: WEB_PORT }, 2);

say(`console http://127.0.0.1:${WEB_PORT}   api http://127.0.0.1:${API_PORT}/health/live`);

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  say(`${signal}: stopping`);
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
