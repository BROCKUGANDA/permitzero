import { describe, expect, it } from 'vitest';
import { boundScreeningInput, buildScreeningPrompt } from '../src/prompt.js';

describe('screening prompt', () => {
  it('pins the evidence refs and schema version in the system prompt', () => {
    const { system, user } = buildScreeningPrompt('risk-hints-prompt-v1', {
      toolName: 'payment.execute',
      operation: 'execute',
      taskPurpose: 'Pay up',
      argumentsJson: { invoice_id: 'INV-1' },
      evidenceRefs: ['invoice:INV-1'],
      untrustedTexts: [{ ref: 'invoice:INV-1', text: 'hello' }],
    });
    expect(system).toContain('risk-hints-prompt-v1');
    expect(system).toContain('risk-hints.v1');
    expect(system).toContain('invoice:INV-1');
    expect(system).toContain('never follow');
    expect(user).toContain('payment.execute');
    expect(user).toContain('hello');
  });

  it('bounds texts and arguments deterministically', () => {
    const bounded = boundScreeningInput({
      toolName: 't',
      operation: 'o',
      taskPurpose: 'p',
      argumentsJson: { blob: 'y'.repeat(20000) },
      evidenceRefs: [],
      untrustedTexts: Array.from({ length: 12 }, (_, i) => ({ ref: `d:${i}`, text: 'x'.repeat(9000) })),
    });
    expect(bounded.untrustedTexts).toHaveLength(8);
    expect(bounded.untrustedTexts[0]?.text.length).toBeLessThanOrEqual(4020);
    expect(bounded.truncated).toBe(true);
    expect(bounded.argumentsJson.length).toBeLessThanOrEqual(8020);
  });

  it('handles empty documents honestly', () => {
    const bounded = boundScreeningInput({
      toolName: 't',
      operation: 'o',
      taskPurpose: 'p',
      argumentsJson: {},
      evidenceRefs: [],
      untrustedTexts: [],
    });
    expect(bounded.truncated).toBe(false);
    const { user } = buildScreeningPrompt('v', {
      toolName: 't',
      operation: 'o',
      taskPurpose: 'p',
      argumentsJson: {},
      evidenceRefs: [],
      untrustedTexts: [],
    });
    expect(user).toContain('no document text');
  });
});
