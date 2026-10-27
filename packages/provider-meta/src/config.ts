/**
 * Meta provider configuration. Everything comes from the environment; the API
 * key and model id have no defaults and are never valid to invent (PRD
 * FR-072). Failures name the variable, never the value.
 */
import { RISK_HINTS_SCHEMA_VERSION } from '@permitzero/schemas';

export interface MetaProviderConfig {
  /** Bearer [REDACTED] the Meta Model API. Held in memory only, never logged. */
  apiKey: string;
  baseUrl: string;
  /** Exact model id from the project dashboard. Never defaulted. */
  modelId: string;
  timeoutMs: number;
  maxAttempts: number;
  maxConcurrency: number;
  retryBaseMs: number;
  retryCapMs: number;
  promptVersion: string;
  breakerThreshold: number;
  breakerCooldownMs: number;
}

export const DEFAULT_BASE_URL = 'https://api.meta.ai/v1';
export const DEFAULT_PROMPT_VERSION = 'risk-hints-prompt-v1';

function raw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = raw(env, name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function intIn(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const value = raw(env, name);
  if (value === undefined) return def;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer within ${min}..${max}.`);
  }
  return parsed;
}

export function loadMetaConfig(env: NodeJS.ProcessEnv = process.env): MetaProviderConfig {
  const apiKey = required(env, 'MODEL_API_KEY');
  const modelId = required(env, 'MODEL_ID');
  const baseUrl = raw(env, 'MODEL_API_BASE_URL') ?? DEFAULT_BASE_URL;
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new Error('MODEL_API_BASE_URL must be an absolute URL.');
  }
  if (parsedBase.protocol !== 'https:' && parsedBase.protocol !== 'http:') {
    throw new Error('MODEL_API_BASE_URL must use http(s).');
  }
  const schemaVersion = raw(env, 'MODEL_SCHEMA_VERSION') ?? RISK_HINTS_SCHEMA_VERSION;
  if (schemaVersion !== RISK_HINTS_SCHEMA_VERSION) {
    throw new Error(
      `MODEL_SCHEMA_VERSION ${schemaVersion} is not supported; this client speaks ${RISK_HINTS_SCHEMA_VERSION}.`,
    );
  }
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    modelId,
    timeoutMs: intIn(env, 'MODEL_TIMEOUT_MS', 30000, 1000, 120000),
    maxAttempts: intIn(env, 'MODEL_MAX_ATTEMPTS', 5, 1, 10),
    maxConcurrency: intIn(env, 'MODEL_MAX_CONCURRENCY', 4, 1, 32),
    retryBaseMs: intIn(env, 'MODEL_RETRY_BASE_MS', 250, 0, 60000),
    retryCapMs: intIn(env, 'MODEL_RETRY_CAP_MS', 8000, 0, 120000),
    promptVersion: raw(env, 'MODEL_PROMPT_VERSION') ?? DEFAULT_PROMPT_VERSION,
    breakerThreshold: intIn(env, 'MODEL_BREAKER_THRESHOLD', 5, 1, 100),
    breakerCooldownMs: intIn(env, 'MODEL_BREAKER_COOLDOWN_MS', 30000, 1000, 600000),
  };
}
