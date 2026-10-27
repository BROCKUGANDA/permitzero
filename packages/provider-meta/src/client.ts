/**
 * Meta Model API client: OpenAI-compatible chat completions with strict
 * response validation. Resilience posture is fail-closed: transport trouble,
 * rate limits and server errors retry with bounded backoff; auth and request
 * errors fail fast; anything unparseable or semantically invalid yields no
 * hints at all. A circuit breaker stops calling a sick provider, and a
 * semaphore caps concurrent calls. The key never appears in an error, a log
 * line, or a persisted record — this module has no logging at all.
 */
import { RiskSignalKind } from '@permitzero/domain/reason-codes';
import type { RiskHints } from '@permitzero/domain/types';
import {
  RISK_HINTS_SCHEMA_VERSION,
  riskHintsSchema,
  validateRiskHintsSemantics,
} from '@permitzero/schemas';
import type { MetaProviderConfig } from './config.js';
import { boundScreeningInput, buildScreeningPrompt, riskHintsJsonSchema } from './prompt.js';
import type { ScreeningInput } from './prompt.js';

export type MetaErrorClass =
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'AUTH_ERROR'
  | 'REQUEST_ERROR'
  | 'SCHEMA_INVALID'
  | 'SEMANTICS_INVALID'
  | 'BREAKER_OPEN';

export class MetaProviderError extends Error {
  readonly errorClass: MetaErrorClass;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    errorClass: MetaErrorClass,
    message: string,
    opts?: { status?: number | null; retryable?: boolean; retryAfterMs?: number | null },
  ) {
    super(message);
    this.name = 'MetaProviderError';
    this.errorClass = errorClass;
    this.status = opts?.status ?? null;
    this.retryable = opts?.retryable ?? false;
    this.retryAfterMs = opts?.retryAfterMs ?? null;
  }
}

export interface ProviderAnalyzeResult {
  hints: RiskHints;
  modelId: string;
  promptVersion: string;
  latencyMs: number;
}

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ProviderStatus {
  enabled: boolean;
  status: 'ok' | 'degraded' | 'down' | 'disabled';
  breaker: BreakerState;
  modelId: string | null;
}

type FetchFn = typeof fetch;

export interface ClientDeps {
  fetchFn?: FetchFn;
  sleepMs?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  /** Inject randomness for deterministic tests; defaults to Math.random. */
  random?: () => number;
}

const MAX_TOKENS = 1500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** FIFO semaphore so one burst of intakes cannot stampede the provider. */
class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.running < this.limit) {
      this.running += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.running -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

export class MetaProviderClient {
  private readonly fetchFn: FetchFn;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly random: () => number;
  private readonly semaphore: Semaphore;
  private breaker: BreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAtMs = 0;

  constructor(
    private readonly config: MetaProviderConfig,
    deps: ClientDeps = {},
  ) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleepMs = deps.sleepMs ?? defaultSleep;
    this.nowMs = deps.nowMs ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.semaphore = new Semaphore(config.maxConcurrency);
  }

  status(): ProviderStatus {
    this.maybeHalfOpen();
    return {
      enabled: true,
      status: this.breaker === 'OPEN' ? 'down' : this.breaker === 'HALF_OPEN' ? 'degraded' : 'ok',
      breaker: this.breaker,
      modelId: this.config.modelId,
    };
  }

  async analyze(input: ScreeningInput): Promise<ProviderAnalyzeResult> {
    this.maybeHalfOpen();
    if (this.breaker === 'OPEN') {
      throw new MetaProviderError('BREAKER_OPEN', 'Provider circuit is open; refusing the call.', { retryable: true });
    }
    const release = await this.semaphore.acquire();
    const started = this.nowMs();
    try {
      const hints = await this.attempt(input);
      this.onSuccess();
      return {
        hints,
        modelId: this.config.modelId,
        promptVersion: this.config.promptVersion,
        latencyMs: this.nowMs() - started,
      };
    } catch (err) {
      this.onFailure(err);
      throw err;
    } finally {
      release();
    }
  }

  // -- Breaker: transport/server/rate-limit/timeout trouble trips it. Auth,
  // request-shape and response-content failures are caller-side or prompt-side
  // and must not take the provider offline for everyone else. --

  private maybeHalfOpen(): void {
    if (this.breaker === 'OPEN' && this.nowMs() - this.openedAtMs >= this.config.breakerCooldownMs) {
      this.breaker = 'HALF_OPEN';
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.breaker = 'CLOSED';
  }

  private onFailure(err: unknown): void {
    if (!(err instanceof MetaProviderError)) {
      this.trip();
      return;
    }
    switch (err.errorClass) {
      case 'TIMEOUT':
      case 'NETWORK_ERROR':
      case 'RATE_LIMITED':
      case 'PROVIDER_ERROR':
        this.trip();
        return;
      default:
        return;
    }
  }

  private trip(): void {
    this.consecutiveFailures += 1;
    if (this.breaker === 'HALF_OPEN' || this.consecutiveFailures >= this.config.breakerThreshold) {
      this.breaker = 'OPEN';
      this.openedAtMs = this.nowMs();
    }
  }

  // -- Request loop --

  private async attempt(input: ScreeningInput): Promise<RiskHints> {
    const prompt = buildScreeningPrompt(this.config.promptVersion, input);
    const knownRefs = [...boundScreeningInput(input).evidenceRefs];
    let lastError: MetaProviderError | null = null;
    for (let n = 0; n < this.config.maxAttempts; n += 1) {
      try {
        const raw = await this.post(prompt.system, prompt.user);
        return this.parse(raw, knownRefs);
      } catch (err) {
        const failure =
          err instanceof MetaProviderError
            ? err
            : new MetaProviderError('NETWORK_ERROR', 'Provider call failed.', { retryable: true });
        lastError = failure;
        if (!failure.retryable || n + 1 >= this.config.maxAttempts) throw failure;
        await this.sleepMs(this.backoffMs(n, failure));
      }
    }
    throw lastError ?? new MetaProviderError('PROVIDER_ERROR', 'Provider call failed.', { retryable: true });
  }

  private backoffMs(attempt: number, failure: MetaProviderError): number {
    const exponential = Math.min(this.config.retryCapMs, this.config.retryBaseMs * 2 ** attempt);
    const jitter = Math.floor(this.random() * (this.config.retryBaseMs + 1));
    let wait = exponential + jitter;
    if (failure.errorClass === 'RATE_LIMITED' && failure.retryAfterMs !== null) {
      wait = Math.min(failure.retryAfterMs, this.config.retryCapMs);
    }
    return Math.max(0, wait);
  }

  private async post(system: string, user: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.modelId,
          temperature: 0,
          max_tokens: MAX_TOKENS,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'risk_hints', strict: true, schema: riskHintsJsonSchema() },
          },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (res.ok) return this.contentOf(res);
      throw this.classifyStatus(res);
    } catch (err) {
      if (err instanceof MetaProviderError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new MetaProviderError('TIMEOUT', `Provider call timed out after ${this.config.timeoutMs}ms.`, {
          retryable: true,
        });
      }
      throw new MetaProviderError('NETWORK_ERROR', 'Provider call failed.', { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  private async contentOf(res: Response): Promise<string> {
    let body: unknown;
    try {
      body = (await res.json()) as unknown;
    } catch {
      throw new MetaProviderError('SCHEMA_INVALID', 'Provider returned a non-JSON body.', { status: res.status });
    }
    const content = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new MetaProviderError('SCHEMA_INVALID', 'Provider returned no message content.', { status: res.status });
    }
    return content;
  }

  private classifyStatus(res: Response): MetaProviderError {
    const status = res.status;
    if (status === 429) {
      return new MetaProviderError('RATE_LIMITED', 'Provider rate limit hit.', {
        status,
        retryable: true,
        retryAfterMs: retryAfterMs(res),
      });
    }
    if (status === 401 || status === 403) {
      return new MetaProviderError('AUTH_ERROR', `Provider refused the credentials (HTTP ${status}).`, { status });
    }
    if (status >= 500) {
      return new MetaProviderError('PROVIDER_ERROR', `Provider error (HTTP ${status}).`, { status, retryable: true });
    }
    return new MetaProviderError('REQUEST_ERROR', `Provider rejected the request (HTTP ${status}).`, { status });
  }

  private parse(raw: string, knownRefs: readonly string[]): RiskHints {
    const json = unwrapFences(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch {
      throw new MetaProviderError('SCHEMA_INVALID', 'Provider output is not valid JSON.');
    }
    const shaped = riskHintsSchema.safeParse(parsed);
    if (!shaped.success) {
      const first = shaped.error.issues[0];
      const where = first ? first.path.join('.') || 'body' : 'body';
      throw new MetaProviderError('SCHEMA_INVALID', `Provider output failed validation at ${where}.`);
    }
    const dto = shaped.data;
    const issues = validateRiskHintsSemantics(dto, knownRefs);
    if (issues.length > 0) {
      throw new MetaProviderError('SEMANTICS_INVALID', `Provider output failed semantic checks at ${issues[0]?.path ?? 'body'}.`);
    }
    return {
      schemaVersion: RISK_HINTS_SCHEMA_VERSION,
      instructionInjectionIndicators: dto.instruction_injection_indicators.map((i) => ({
        kind: i.kind as RiskSignalKind,
        evidenceRef: i.evidence_ref,
        confidence: i.confidence,
      })),
      extractedFacts: toFactRecord(dto),
      missingEvidence: [...dto.missing_evidence],
      summary: dto.summary,
    };
  }
}

/** Be liberal in what the transport wraps: some providers fence JSON in markdown. */
function unwrapFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const lines = trimmed.split('\n');
  if (lines[0]?.startsWith('```')) lines.shift();
  if (lines.length > 0 && lines[lines.length - 1]?.trim() === '```') lines.pop();
  return lines.join('\n').trim();
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  if (!Number.isInteger(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

/** Drop nulls; the domain record has no boolean slot, so flags become 1/0. */
function toFactRecord(dto: {
  extracted_facts: Record<string, string | number | boolean | null>;
}): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(dto.extracted_facts)) {
    if (value === null) continue;
    if (typeof value === 'boolean') out[key] = value ? 1 : 0;
    else out[key] = value;
  }
  return out;
}
