import { describe, expect, it } from 'vitest';
import { createMemoryStores } from '@permitzero/broker';
import { CodeExecutionFinanceConnector } from '../src/code-execution-connector.js';

const TENANT = 'ten_test';

describe('CodeExecutionFinanceConnector', () => {
  it('runs a node snippet and captures stdout', async () => {
    const stores = createMemoryStores({ clock: () => new Date('2026-11-19T12:00:00Z') });
    const connector = new CodeExecutionFinanceConnector({
      connectorId: 'con_code',
      data: stores.data,
      allowedLanguages: ['node'],
      timeoutMs: 5_000,
    });
    const result = await connector.executeCode({
      tenantId: TENANT,
      connectorId: 'con_code',
      idempotencyKey: 'code-key-1',
      code: "console.log('hello', process.argv[2]);",
      language: 'node',
      args: ['world'],
      actionId: 'act_code_1',
      executionId: 'exe_code_1',
      traceId: 'trc_code_1',
    });
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') return;
    expect(result.receipt.simulated).toBe(false);
    const ledger = await stores.data.listLedger(TENANT);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.detailRedacted).toMatchObject({ language: 'node', exit_code: 0 });
  });

  it('returns FAILED_TERMINAL on a non-zero exit', async () => {
    const stores = createMemoryStores({ clock: () => new Date() });
    const connector = new CodeExecutionFinanceConnector({
      connectorId: 'con_code',
      data: stores.data,
      allowedLanguages: ['node'],
      timeoutMs: 5_000,
    });
    const result = await connector.executeCode({
      tenantId: TENANT,
      connectorId: 'con_code',
      idempotencyKey: 'code-key-2',
      code: 'process.exit(7);',
      language: 'node',
      args: [],
      actionId: 'act_code_2',
      executionId: 'exe_code_2',
      traceId: 'trc_code_2',
    });
    expect(result.status).toBe('FAILED_TERMINAL');
    if (result.status === 'FAILED_TERMINAL') expect(result.errorClass).toMatch(/^EXIT_7:/);
  });

  it('returns TIMEOUT_AFTER_DISPATCH when the run exceeds the wall-clock limit', async () => {
    const stores = createMemoryStores({ clock: () => new Date() });
    const connector = new CodeExecutionFinanceConnector({
      connectorId: 'con_code',
      data: stores.data,
      allowedLanguages: ['node'],
      timeoutMs: 200,
    });
    const result = await connector.executeCode({
      tenantId: TENANT,
      connectorId: 'con_code',
      idempotencyKey: 'code-key-3',
      code: 'setInterval(() => {}, 1000);',
      language: 'node',
      args: [],
      actionId: 'act_code_3',
      executionId: 'exe_code_3',
      traceId: 'trc_code_3',
    });
    expect(result).toEqual({ status: 'TIMEOUT_AFTER_DISPATCH' });
  });

  it('refuses a disallowed language and an oversized payload before spawning', async () => {
    const stores = createMemoryStores({ clock: () => new Date() });
    const connector = new CodeExecutionFinanceConnector({
      connectorId: 'con_code',
      data: stores.data,
      allowedLanguages: ['node'],
      maxCodeBytes: 16,
    });
    const language = await connector.executeCode({
      tenantId: TENANT,
      connectorId: 'con_code',
      idempotencyKey: 'code-key-4',
      code: 'x',
      language: 'python',
      args: [],
      actionId: 'act_code_4',
      executionId: 'exe_code_4',
      traceId: 'trc_code_4',
    });
    expect(language).toEqual({ status: 'FAILED_TERMINAL', errorClass: 'LANGUAGE_NOT_ALLOWED' });

    const oversized = await connector.executeCode({
      tenantId: TENANT,
      connectorId: 'con_code',
      idempotencyKey: 'code-key-5',
      code: "console.log('x'.repeat(100));",
      language: 'node',
      args: [],
      actionId: 'act_code_5',
      executionId: 'exe_code_5',
      traceId: 'trc_code_5',
    });
    expect(oversized).toEqual({ status: 'FAILED_TERMINAL', errorClass: 'INVALID_CODE_SIZE' });
  });

  it('returns the original receipt on a repeated idempotency key', async () => {
    const stores = createMemoryStores({ clock: () => new Date() });
    const connector = new CodeExecutionFinanceConnector({
      connectorId: 'con_code',
      data: stores.data,
      allowedLanguages: ['node'],
      timeoutMs: 5_000,
    });
    const first = await connector.executeCode({
      tenantId: TENANT,
      connectorId: 'con_code',
      idempotencyKey: 'code-key-6',
      code: "console.log('once');",
      language: 'node',
      args: [],
      actionId: 'act_code_6',
      executionId: 'exe_code_6',
      traceId: 'trc_code_6',
    });
    const second = await connector.executeCode({
      tenantId: TENANT,
      connectorId: 'con_code',
      idempotencyKey: 'code-key-6',
      code: "console.log('twice');",
      language: 'node',
      args: [],
      actionId: 'act_code_6b',
      executionId: 'exe_code_6b',
      traceId: 'trc_code_6b',
    });
    expect(first.status).toBe('SUCCEEDED');
    expect(second.status).toBe('SUCCEEDED');
    if (first.status !== 'SUCCEEDED' || second.status !== 'SUCCEEDED') return;
    expect(second.receipt.receiptHash).toBe(first.receipt.receiptHash);
  });
});
