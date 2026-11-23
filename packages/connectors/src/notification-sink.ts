/**
 * A notification sink — the outbound "sink" adapter of the runtime boundary.
 *
 * A sink is where an action's consequence leaves PermitZero for a human or an
 * external system (Slack/Teams/PagerDuty webhook, email gateway). It is a
 * different shape from `FinanceConnector`: a sink does not move money or
 * enforce permission — it *reports*. But it still benefits from the same
 * honest-outcome discipline, because a notification that silently failed to
 * deliver is a notification that never happened, and a notification that
 * delivered twice is spam.
 *
 * Invariants:
 *  - Idempotent by (tenant, deliveryId): a repeated delivery id returns the
 *    original receipt and sends nothing again. The tenant is part of the key
 *    so one tenant cannot read another tenant's receipt by guessing an id.
 *  - Retryable failures (network, 5xx, 429) are reported as retryable; a
 *    missing or misconfigured destination is terminal.
 *  - The destination URL must be allowlisted (no SSRF, no surprise
 *    exfiltration): an empty allowlist means no delivery at all.
 *  - The sink never carries credentials in the payload; destination auth is
 *    resolved from the connector's own secret reference by the caller.
 */
export interface NotificationReceipt {
  deliveryId: string;
  deliveredAt: Date;
  destination: string;
  statusCode: number;
}

export interface NotificationRequest {
  deliveryId: string;
  destination: string;
  channel: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  tenantId: string | null;
  traceId: string | null;
}

export type NotificationDeliveryResult =
  | { status: 'DELIVERED'; receipt: NotificationReceipt }
  | { status: 'FAILED_RETRYABLE'; errorClass: string }
  | { status: 'FAILED_TERMINAL'; errorClass: string };

export interface NotificationSink {
  deliver(request: NotificationRequest): Promise<NotificationDeliveryResult>;
}

export interface HttpNotificationSinkConfig {
  /** Allowlisted destination hosts. Empty = no delivery (fail closed). */
  allowedHosts: readonly string[];
  /** Per-request timeout in ms. Default 5_000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_CACHED_RECEIPTS = 10_000;

function deliveryKey(request: NotificationRequest): string {
  return `${request.tenantId ?? ''}:${request.deliveryId}`;
}

/**
 * Both the in-flight promise and the completed receipt are cached. Caching
 * only the receipt would still send twice for two concurrent deliveries of
 * the same id — the exact case an at-least-once publisher produces.
 */
class DeliveryIdempotency {
  private readonly receipts = new Map<string, NotificationReceipt>();
  private readonly inFlight = new Map<string, Promise<NotificationDeliveryResult>>();

  async run(key: string, send: () => Promise<NotificationDeliveryResult>): Promise<NotificationDeliveryResult> {
    const delivered = this.receipts.get(key);
    if (delivered) return { status: 'DELIVERED', receipt: delivered };
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const attempt = send();
    this.inFlight.set(key, attempt);
    try {
      const result = await attempt;
      if (result.status === 'DELIVERED') {
        // Insertion order is the arrival order; evict the oldest when the
        // cache passes its bound so a long-lived sink cannot grow forever.
        if (this.receipts.size >= MAX_CACHED_RECEIPTS) {
          const oldest = this.receipts.keys().next().value;
          if (oldest !== undefined) this.receipts.delete(oldest);
        }
        this.receipts.set(key, result.receipt);
      }
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }
}

export class HttpNotificationSink implements NotificationSink {
  private readonly allowedHosts: readonly string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly idempotency = new DeliveryIdempotency();

  constructor(config: HttpNotificationSinkConfig) {
    this.allowedHosts = config.allowedHosts;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async deliver(request: NotificationRequest): Promise<NotificationDeliveryResult> {
    return this.idempotency.run(deliveryKey(request), () => this.send(request));
  }

  private async send(request: NotificationRequest): Promise<NotificationDeliveryResult> {
    let url: URL;
    try {
      url = new URL(request.destination);
    } catch {
      return { status: 'FAILED_TERMINAL', errorClass: 'INVALID_DESTINATION' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { status: 'FAILED_TERMINAL', errorClass: 'INVALID_DESTINATION_SCHEME' };
    }
    const host = url.hostname.toLowerCase();
    if (
      this.allowedHosts.length === 0 ||
      !this.allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))
    ) {
      return { status: 'FAILED_TERMINAL', errorClass: 'DESTINATION_NOT_ALLOWED' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await this.fetchImpl(request.destination, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: request.channel,
          message: request.message,
          severity: request.severity,
          tenant_id: request.tenantId,
          trace_id: request.traceId,
          delivery_id: request.deliveryId,
        }),
        signal: controller.signal,
      });
    } catch {
      return { status: 'FAILED_RETRYABLE', errorClass: 'TRANSPORT_ERROR' };
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 429 || response.status >= 500) {
      return { status: 'FAILED_RETRYABLE', errorClass: `HTTP_${response.status}` };
    }
    if (response.status >= 400) {
      return { status: 'FAILED_TERMINAL', errorClass: `HTTP_${response.status}` };
    }
    return {
      status: 'DELIVERED',
      receipt: {
        deliveryId: request.deliveryId,
        deliveredAt: new Date(),
        destination: request.destination,
        statusCode: response.status,
      },
    };
  }
}

/** In-memory sink for tests and offline operation. Always succeeds. */
export class MemoryNotificationSink implements NotificationSink {
  readonly delivered: NotificationRequest[] = [];
  private readonly idempotency = new DeliveryIdempotency();

  async deliver(request: NotificationRequest): Promise<NotificationDeliveryResult> {
    return this.idempotency.run(deliveryKey(request), async () => {
      this.delivered.push(request);
      return {
        status: 'DELIVERED',
        receipt: {
          deliveryId: request.deliveryId,
          deliveredAt: new Date(),
          destination: request.destination,
          statusCode: 202,
        },
      };
    });
  }
}
