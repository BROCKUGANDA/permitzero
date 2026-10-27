/**
 * API configuration. Everything comes from the environment with safe
 * defaults; missing secrets fail fast with a message that names the variable
 * but never prints a value.
 */
export interface ApiConfig {
  host: string;
  port: number;
  appEnv: string;
  version: string;
  databaseUrl: string;
  redisUrl: string | null;
  permitSigningKey: string;
  permitSigningKeyId: string;
  permitTtlSeconds: number;
  modelProvider: 'disabled' | 'static' | 'meta';
  auditHmacKey: string | null;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  maxBodyBytes: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function intIn(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer within ${min}..${max}.`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const permitSigningKey = required(env, 'PERMIT_SIGNING_KEY');
  if (permitSigningKey.length < 16) {
    throw new Error('PERMIT_SIGNING_KEY must be at least 16 characters.');
  }
  const explicitOff = (env['MODEL_ENABLED'] ?? '').toLowerCase() === 'false';
  const requested = env['MODEL_PROVIDER'] ?? 'disabled';
  if (requested !== 'disabled' && requested !== 'static' && requested !== 'meta') {
    throw new Error("MODEL_PROVIDER must be 'disabled', 'static' or 'meta'.");
  }
  // MODEL_ENABLED=false is an explicit deterministic-only deployment choice
  // and wins over the provider selection. The runtime check above makes the
  // cast total.
  const modelProvider: ApiConfig['modelProvider'] = explicitOff
    ? 'disabled'
    : (requested as ApiConfig['modelProvider']);
  return {
    host: env['HOST'] ?? '127.0.0.1',
    port: intIn(env, 'PORT', 3000, 1, 65535),
    appEnv: env['APP_ENV'] ?? 'development',
    version: env['APP_VERSION'] ?? '0.1.0',
    databaseUrl: required(env, 'DATABASE_URL'),
    redisUrl: env['REDIS_URL'] ?? null,
    permitSigningKey,
    permitSigningKeyId: env['PERMIT_SIGNING_KEY_ID'] ?? 'k1',
    permitTtlSeconds: intIn(env, 'PERMIT_TTL_SECONDS', 300, 1, 3600),
    modelProvider,
    auditHmacKey: env['AUDIT_HMAC_KEY'] ?? null,
    rateLimitMax: intIn(env, 'RATE_LIMIT_MAX', 500, 1, 100000),
    rateLimitWindowMs: intIn(env, 'RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000),
    maxBodyBytes: intIn(env, 'MAX_BODY_BYTES', 1_048_576, 1024, 50_000_000),
  };
}
