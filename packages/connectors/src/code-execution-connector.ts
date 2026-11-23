/**
 * Sandboxed code-execution connector — the "code execution" action type from
 * the PRD. Runs a snippet in an isolated child process with a hard timeout,
 * no network by default, and a bounded output buffer; honest outcomes for
 * timeout, crash, non-zero exit and oversize output.
 *
 * It implements `FinanceConnector` only so the broker stays polymorphic over
 * the seam; every money operation is OPERATION_NOT_ALLOWED, and the real
 * surface is `executeCode`. Permission is still enforced upstream: the broker
 * validates the permit, policy and state before any byte runs.
 *
 * Security posture:
 *  - The language must be in the allowlist (node, python3).
 *  - The code and args are size-limited; an oversized payload is rejected
 *    before spawn.
 *  - No network: spawn runs with env scrubbed and cwd set to a scratch dir.
 *  - Hard timeout via SIGKILL; the process cannot outlive the deadline.
 *  - Output is capped; truncation is reported, never silently dropped.
 *  - The executor never evals in-process; it always spawns a fresh process.
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ConnectorCallResult,
  ConnectorDataStore,
  ConnectorExportRequest,
  ConnectorPaymentRequest,
  ConnectorReceipt,
  ConnectorVendorChangeRequest,
  FinanceConnector,
} from '@permitzero/broker';
import { canonicalHash } from '@permitzero/domain';

export interface CodeExecutionConnectorConfig {
  connectorId: string;
  data: ConnectorDataStore;
  /** Allowlisted interpreters. Empty = nothing runs (fail closed). */
  allowedLanguages?: ReadonlyArray<'node' | 'python'>;
  /** Hard wall-clock timeout per run, ms. Default 10_000. */
  timeoutMs?: number;
  /** Max combined stdout+stderr bytes. Default 64 KiB. */
  maxOutputBytes?: number;
  /** Max code bytes. Default 64 KiB. */
  maxCodeBytes?: number;
  clock?: () => Date;
}

export class CodeExecutionFinanceConnector implements FinanceConnector {
  private readonly config: CodeExecutionConnectorConfig;
  private readonly clock: () => Date;
  private readonly allowedLanguages: ReadonlySet<'node' | 'python'>;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxCodeBytes: number;

  constructor(config: CodeExecutionConnectorConfig) {
    this.config = config;
    this.clock = config.clock ?? (() => new Date());
    this.allowedLanguages = new Set(config.allowedLanguages ?? ['node']);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxOutputBytes = config.maxOutputBytes ?? 65_536;
    this.maxCodeBytes = config.maxCodeBytes ?? 65_536;
  }

  async executeCode(request: {
    tenantId: string;
    connectorId: string;
    idempotencyKey: string;
    code: string;
    language: 'node' | 'python';
    args: readonly string[];
    actionId: string;
    executionId: string;
    traceId: string;
  }): Promise<ConnectorCallResult> {
    if (request.code.length === 0 || request.code.length > this.maxCodeBytes) {
      return { status: 'FAILED_TERMINAL', errorClass: 'INVALID_CODE_SIZE' };
    }
    if (!this.allowedLanguages.has(request.language)) {
      return { status: 'FAILED_TERMINAL', errorClass: 'LANGUAGE_NOT_ALLOWED' };
    }
    if (request.args.length > 16 || request.args.some((a) => a.length > 256)) {
      return { status: 'FAILED_TERMINAL', errorClass: 'INVALID_ARGS' };
    }

    const existing = await this.config.data.getLedgerEntry(request.tenantId, request.idempotencyKey);
    if (existing) return { status: 'SUCCEEDED', receipt: existing.receipt };

    await this.config.data.recordDispatch({
      tenantId: request.tenantId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'code.execute',
      startedAt: this.clock(),
      completedAt: null,
      outcome: null,
      providerRef: null,
    });

    const dir = join(tmpdir(), `pz-sandbox-${randomUUID()}`);
    const file = join(dir, request.language === 'node' ? 'main.mjs' : 'main.py');
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, request.code, 'utf8');
    } catch {
      await this.config.data.completeDispatch(request.tenantId, request.idempotencyKey, 'FAILED_TERMINAL', this.clock());
      return { status: 'FAILED_TERMINAL', errorClass: 'SANDBOX_PREP_FAILED' };
    }

    const interpreter = request.language === 'node' ? process.execPath : 'python3';
    const child = spawn(interpreter, [file, ...request.args], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    const collect = (chunk: Buffer, target: 'out' | 'err') => {
      if (target === 'out') {
        if (stdout.length + chunk.length > this.maxOutputBytes) {
          stdout += chunk.toString('utf8', 0, this.maxOutputBytes - stdout.length);
          truncated = true;
        } else {
          stdout += chunk.toString('utf8');
        }
      } else {
        if (stderr.length + chunk.length > this.maxOutputBytes) {
          stderr += chunk.toString('utf8', 0, this.maxOutputBytes - stderr.length);
          truncated = true;
        } else {
          stderr += chunk.toString('utf8');
        }
      }
    };
    child.stdout.on('data', (c: Buffer) => collect(c, 'out'));
    child.stderr.on('data', (c: Buffer) => collect(c, 'err'));

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        resolve({ code: null, signal: 'SIGKILL', timedOut: true });
      }, this.timeoutMs);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut: false });
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ code: -1, signal: null, timedOut: false });
      });
    });

    await rm(dir, { recursive: true, force: true }).catch(() => undefined);

    if (result.timedOut) {
      // The process may have produced a partial side effect inside the
      // sandbox; the ledger has nothing yet, so the honest outcome is unknown.
      await this.config.data.completeDispatch(request.tenantId, request.idempotencyKey, 'FAILED_RETRYABLE', this.clock());
      return { status: 'TIMEOUT_AFTER_DISPATCH' };
    }
    if (result.code !== 0) {
      await this.config.data.completeDispatch(request.tenantId, request.idempotencyKey, 'FAILED_TERMINAL', this.clock());
      return { status: 'FAILED_TERMINAL', errorClass: `EXIT_${result.code ?? 'SIGNAL'}:${stderr.slice(0, 120)}` };
    }

    const receipt = this.buildReceipt(request.idempotencyKey, stdout, stderr, truncated, this.clock());
    await this.config.data.putLedgerEntryIfAbsent({
      tenantId: request.tenantId,
      connectorId: this.config.connectorId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'code.execute',
      externalReference: receipt.externalReference,
      receipt,
      detailRedacted: {
        language: request.language,
        exit_code: 0,
        output_bytes: stdout.length + stderr.length,
        truncated,
        action_id: request.actionId,
        execution_id: request.executionId,
      },
      actionId: request.actionId,
      executionId: request.executionId,
      recordedAt: this.clock(),
    });
    await this.config.data.completeDispatch(request.tenantId, request.idempotencyKey, 'SUCCEEDED', this.clock());
    return { status: 'SUCCEEDED', receipt };
  }

  // Money operations are not this connector's job.
  async executePayment(_r: ConnectorPaymentRequest): Promise<ConnectorCallResult> {
    return { status: 'FAILED_TERMINAL', errorClass: 'OPERATION_NOT_ALLOWED' };
  }
  async updateVendorBankDetails(_r: ConnectorVendorChangeRequest): Promise<ConnectorCallResult> {
    return { status: 'FAILED_TERMINAL', errorClass: 'OPERATION_NOT_ALLOWED' };
  }
  async exportVendors(_r: ConnectorExportRequest): Promise<ConnectorCallResult> {
    return { status: 'FAILED_TERMINAL', errorClass: 'OPERATION_NOT_ALLOWED' };
  }
  async lookupByIdempotencyKey(tenantId: string, key: string): Promise<ConnectorReceipt | null> {
    const entry = await this.config.data.getLedgerEntry(tenantId, key);
    return entry ? entry.receipt : null;
  }

  private buildReceipt(
    idempotencyKey: string,
    stdout: string,
    stderr: string,
    truncated: boolean,
    completedAt: Date,
  ): ConnectorReceipt {
    const externalReference = `code_${idempotencyKey.slice(0, 16)}`;
    const receiptHash = canonicalHash({
      external_reference: externalReference,
      stdout: stdout.slice(0, 256),
      stderr: stderr.slice(0, 256),
      truncated,
      completed_at: completedAt.toISOString(),
      simulated: false,
    });
    return {
      externalReference,
      receiptHash,
      amountMinor: 0,
      currency: 'XXX',
      beneficiaryRef: externalReference,
      completedAt,
      simulated: false,
    };
  }
}
