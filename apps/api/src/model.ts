/**
 * Model-adapter wiring. The provider is advisory-only: its output may add
 * risk signals and escalate to human review, but it can never produce an
 * allow (FR-071 — enforced structurally in @permitzero/policy, not here).
 *
 * Two adapters ship with the API slice. `DisabledModelAdapter` is the
 * default: deterministic-only mode, an explicit deployment choice, reported
 * honestly on /v1/status. `StaticModelAdapter` is a deterministic test double
 * that screens untrusted text for injection-shaped phrasing; it exists so the
 * escalation path is provable without a network call. A real provider client
 * implements `ModelAdapter` and is selected in server.ts.
 */
import { RiskSignalKind } from '@permitzero/domain';
import type { EvidenceRef, RiskHints } from '@permitzero/domain';
import type { MetaProviderClient } from '@permitzero/provider-meta';
import { MetaProviderError } from '@permitzero/provider-meta';
import type { MetricsBundle } from '@permitzero/observability';

export interface ModelAnalysisInput {
  tenantId: string;
  actionId: string | null;
  toolName: string;
  operation: string;
  taskPurpose: string;
  argumentsRedacted: Record<string, unknown>;
  evidenceRefs: readonly EvidenceRef[];
  /** Untrusted document text to screen. Never trusted, never executed. */
  untrustedTexts: ReadonlyArray<{ ref: string; text: string }>;
}

export type ModelAnalysisStatus = 'OK' | 'ERROR' | 'TIMEOUT' | 'DISABLED';

export interface ModelAnalysisOutcome {
  status: ModelAnalysisStatus;
  hints: RiskHints | null;
  modelId: string | null;
  /** Prompt version that produced the hints; null when nothing ran. */
  promptVersion: string | null;
  errorClass: string | null;
  latencyMs: number;
}

export interface ModelProviderStatus {
  enabled: boolean;
  status: 'ok' | 'degraded' | 'down' | 'disabled';
  breaker: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  modelId: string | null;
}

export interface ModelAdapter {
  readonly providerName: string;
  readonly enabled: boolean;
  analyze(input: ModelAnalysisInput): Promise<ModelAnalysisOutcome>;
  status(): ModelProviderStatus;
  /**
   * Attach the Prometheus sink this adapter reports screening activity to.
   *
   * Optional, and deliberately so: the disabled adapter never screens and the
   * static double is not the Meta Model API, so neither of them has a screening
   * attempt to report. Only the live provider's attempts are counted, which is
   * what `pz_model_screenings_total` claims to measure.
   */
  attachMetrics?(sink: ModelMetricSink): void;
}

/**
 * The series a screening adapter writes to.
 *
 * A subset of the metrics bundle rather than the whole thing: the adapter has
 * no business reaching for the HTTP counters, and a test can hand it a bundle
 * without standing up a Fastify app.
 */
export interface ModelMetricSink {
  modelScreenings: MetricsBundle['modelScreenings'];
  modelLatency: MetricsBundle['modelLatency'];
}

/**
 * The gauge encoding of a breaker state: 0 closed, 1 half-open, 2 open.
 *
 * Numeric because the alert is `pz_circuit_breaker_state >= 2`, and a state
 * name in a label would make that comparison impossible to write without a
 * regex on the label value.
 */
export function breakerStateValue(breaker: ModelProviderStatus['breaker']): number {
  switch (breaker) {
    case 'OPEN':
      return 2;
    case 'HALF_OPEN':
      return 1;
    default:
      return 0;
  }
}

export class DisabledModelAdapter implements ModelAdapter {
  readonly providerName = 'disabled';
  readonly enabled = false;

  async analyze(_input: ModelAnalysisInput): Promise<ModelAnalysisOutcome> {
    return { status: 'DISABLED', hints: null, modelId: null, promptVersion: null, errorClass: null, latencyMs: 0 };
  }

  status(): ModelProviderStatus {
    return { enabled: false, status: 'disabled', breaker: 'CLOSED', modelId: null };
  }
}

const INJECTION_MARKERS = [
  'ignore all previous instructions',
  'ignore the approval policy',
  'override the policy',
  'disregard the policy',
  'you are now',
  'system prompt:',
  '[system]',
] as const;

/**
 * Deterministic screening double. Flags untrusted text containing
 * injection-shaped phrasing with a fixed advisory confidence; flags nothing
 * otherwise. The confidence is a claim, not a measurement.
 */
export class StaticModelAdapter implements ModelAdapter {
  readonly providerName = 'static';
  readonly enabled = true;

  async analyze(input: ModelAnalysisInput): Promise<ModelAnalysisOutcome> {
    const started = Date.now();
    const indicators: Array<RiskHints['instructionInjectionIndicators'][number]> = [];
    for (const doc of input.untrustedTexts.slice(0, 8)) {
      const lowered = doc.text.toLowerCase();
      if (INJECTION_MARKERS.some((m) => lowered.includes(m))) {
        indicators.push({
          kind: RiskSignalKind.INSTRUCTION_INJECTION,
          evidenceRef: doc.ref,
          confidence: 0.85,
        });
      }
    }
    return {
      status: 'OK',
      hints: {
        schemaVersion: 'risk-hints.v1',
        instructionInjectionIndicators: indicators,
        extractedFacts: {},
        missingEvidence: [],
        summary:
          indicators.length > 0 ? 'static screening flagged injection-shaped phrasing' : 'static screening clean',
      },
      modelId: 'static-v1',
      promptVersion: 'static-v1',
      errorClass: null,
      latencyMs: Date.now() - started,
    };
  }

  status(): ModelProviderStatus {
    return { enabled: true, status: 'ok', breaker: 'CLOSED', modelId: 'static-v1' };
  }
}

/**
 * Live Meta Model API adapter. Provider failures become typed ERROR/TIMEOUT
 * outcomes — never exceptions past this point, never hints — so intake can
 * fail closed through its existing `requiredModelSignalUnavailable` path.
 */
export class MetaModelAdapter implements ModelAdapter {
  readonly providerName = 'meta';
  readonly enabled = true;

  /**
   * The Prometheus sink, attached by `buildApp`.
   *
   * Not a constructor argument: the provider client is built in `server.ts`,
   * before the app — and therefore before the metrics registry — exists. The
   * app owns the registry, so the app wires the two together.
   */
  private sink: ModelMetricSink | null = null;

  constructor(private readonly client: MetaProviderClient) {}

  attachMetrics(sink: ModelMetricSink): void {
    this.sink = sink;
  }

  async analyze(input: ModelAnalysisInput): Promise<ModelAnalysisOutcome> {
    const started = Date.now();
    try {
      const result = await this.client.analyze({
        toolName: input.toolName,
        operation: input.operation,
        taskPurpose: input.taskPurpose,
        argumentsJson: input.argumentsRedacted,
        evidenceRefs: input.evidenceRefs.map((e) => e.ref),
        untrustedTexts: [...input.untrustedTexts],
      });
      const outcome: ModelAnalysisOutcome = {
        status: 'OK',
        hints: result.hints,
        modelId: result.modelId,
        promptVersion: result.promptVersion,
        errorClass: null,
        latencyMs: result.latencyMs,
      };
      recordScreening(this.sink, outcome);
      return outcome;
    } catch (err) {
      const errorClass = err instanceof MetaProviderError ? err.errorClass : 'UNKNOWN';
      const outcome: ModelAnalysisOutcome = {
        status: errorClass === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR',
        hints: null,
        modelId: this.client.status().modelId,
        promptVersion: null,
        errorClass,
        latencyMs: Date.now() - started,
      };
      // The failure path is recorded too, and it is the path that matters: a
      // screening attempt that failed is exactly what the provider-degraded
      // alert is supposed to see, and a counter that only counted successes
      // would report a perfectly healthy provider during an outage.
      recordScreening(this.sink, outcome);
      return outcome;
    }
  }

  status(): ModelProviderStatus {
    return this.client.status();
  }
}

/**
 * Record one screening attempt: the outcome counter and the latency histogram.
 *
 * `error_class` is a label and a label cannot be null, so a successful
 * screening is labelled `none` rather than being left out — an absent label
 * value and a different label value are not the same series, and a query that
 * filters on `error_class=""` would match nothing.
 */
function recordScreening(sink: ModelMetricSink | null, outcome: ModelAnalysisOutcome): void {
  if (!sink) return;
  sink.modelScreenings.inc({ status: outcome.status, error_class: outcome.errorClass ?? 'none' });
  sink.modelLatency.observe(outcome.latencyMs / 1000);
}

export function createModelAdapter(
  kind: 'disabled' | 'static' | 'meta',
  deps?: { meta?: MetaProviderClient },
): ModelAdapter {
  if (kind === 'static') return new StaticModelAdapter();
  if (kind === 'meta') {
    if (!deps?.meta) throw new Error('createModelAdapter(meta) requires a MetaProviderClient.');
    return new MetaModelAdapter(deps.meta);
  }
  return new DisabledModelAdapter();
}
