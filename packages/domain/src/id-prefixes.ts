/**
 * ID prefixes and kinds. Deliberately free of Node APIs so browser bundles
 * (the dashboard validates IDs client-side) can import it without dragging
 * in identifier generation. Add a prefix here and it becomes part of the
 * parsed contract; generation lives in ids.ts.
 */

/** ID prefixes. Add a prefix here and it becomes part of the parsed contract. */
export const ID_PREFIX = {
  tenant: 'ten',
  user: 'usr',
  membership: 'mbr',
  agent: 'agt',
  credential: 'cred',
  policy: 'pol',
  policyRevision: 'polrev',
  action: 'act',
  trace: 'trc',
  approval: 'appr',
  permit: 'pmt',
  execution: 'exe',
  connector: 'con',
  auditEvent: 'aev',
  outboxEvent: 'obx',
  run: 'run',
  simulation: 'sim',
  replay: 'rpl',
  modelEvaluation: 'mev',
  idempotency: 'idm',
  ledger: 'ldg',
  dispatch: 'dsp',
} as const;

export type IdKind = keyof typeof ID_PREFIX;
