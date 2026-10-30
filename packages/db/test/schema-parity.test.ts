/**
 * Schema parity: the Drizzle typed view must match the migrated DDL exactly —
 * every table, every column in both directions, every CHECK by name, and every
 * enum CHECK containing the full domain value list. Drift in either direction
 * fails loudly here instead of silently at runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import {
  ActionState,
  ActorType,
  AgentStatus,
  ApprovalDecision,
  ConnectorStatus,
  EnforcementMode,
  Environment,
  ExecutionState,
  OutboxStatus,
  PolicyRevisionStatus,
  Role,
  VendorStatus,
} from '@permitzero/domain';
import { migrate, schema, type Db } from '../src/index.js';

const ALL_TABLES = schema.ALL_TABLES;
import { closeTestDb, resetTestDb, testDb } from './db-test.js';

let db: Db;

beforeAll(async () => {
  db = await testDb();
});

afterAll(async () => {
  await closeTestDb();
});

async function dbColumns(table: string): Promise<Map<string, string>> {
  const rows = await db.sql<{ column_name: string; data_type: string; udt_name: string }[]>`
    SELECT column_name, data_type, udt_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position`;
  return new Map(rows.map((r) => [r.column_name, r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type]));
}

async function dbChecks(table: string): Promise<Map<string, string>> {
  const rows = await db.sql<{ name: string; def: string }[]>`
    SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = ${table} AND c.contype = 'c'`;
  return new Map(rows.map((r) => [r.name, r.def]));
}

describe('schema parity', () => {
  it('has every table with identical columns in both directions', async () => {
    expect(ALL_TABLES.length).toBeGreaterThan(20);
    for (const table of ALL_TABLES) {
      const name = getTableName(table);
      const drizzleCols = new Map(
        Object.values(getTableColumns(table)).map((col) => [col.name, col.columnType] as const),
      );
      const live = await dbColumns(name);
      expect(live.size, `table ${name} exists`).toBeGreaterThan(0);
      for (const col of drizzleCols.keys()) {
        expect(live.has(col), `${name}.${col} missing in database`).toBe(true);
      }
      for (const col of live.keys()) {
        expect(drizzleCols.has(col), `${name}.${col} missing in drizzle view`).toBe(true);
      }
    }
  });

  it('keeps every drizzle CHECK present in the database', async () => {
    // Table → CHECK names declared in schema.ts. Add new checks here when the
    // schema grows; the unknown-constraint assertion below forces it.
    const expected: Record<string, string[]> = {
      tenants: ['chk_tenants_status', 'chk_tenants_environment', 'chk_tenants_name_nonempty'],
      users: ['chk_users_status'],
      tenant_memberships: ['chk_membership_role', 'chk_membership_status'],
      service_credentials: [
        'chk_service_credentials_subject_type',
        'chk_service_credentials_status',
        'chk_service_credentials_secret_prefix_length',
      ],
      agents: ['chk_agents_environment', 'chk_agents_status', 'chk_agents_revoked_at'],
      policies: ['chk_policies_status', 'chk_policies_version_nonneg'],
      policy_revisions: [
        'chk_policy_revisions_status',
        'chk_policy_revisions_number_positive',
        'chk_policy_revisions_published_at',
        'chk_policy_revisions_hash_shape',
      ],
      actions: [
        'chk_actions_state',
        'chk_actions_decision',
        'chk_actions_actor_type',
        'chk_actions_environment',
        'chk_actions_version_nonneg',
        'chk_actions_required_approvals_nonneg',
        'chk_actions_arguments_hash_shape',
      ],
      approvals: ['chk_approvals_decision', 'chk_approvals_action_hash_shape'],
      permits: [
        'chk_permits_expiry',
        'chk_permits_consumed_xor_revoked',
        'chk_permits_version_nonneg',
        'chk_permits_action_hash_shape',
      ],
      connectors: [
        'chk_connectors_status',
        'chk_connectors_environment',
        'chk_connectors_health_status',
        'chk_connectors_credential_prefix_length',
      ],
      executions: [
        'chk_executions_state',
        'chk_executions_attempt_positive',
        'chk_executions_amount_nonneg',
        'chk_executions_currency_shape',
        'chk_executions_dispatch_after_intent',
      ],
      audit_events: [
        'chk_audit_events_sequence_positive',
        'chk_audit_events_actor_type',
        'chk_audit_events_hash_shape',
        'chk_audit_events_event_type_nonempty',
      ],
      outbox_events: [
        'chk_outbox_status',
        'chk_outbox_queue_name',
        'chk_outbox_attempt_count_nonneg',
        'chk_outbox_max_attempts_positive',
        'chk_outbox_published_at',
      ],
      idempotency_records: ['chk_idempotency_status', 'chk_idempotency_principal_type', 'chk_idempotency_http_status'],
      model_evaluations: ['chk_model_evaluations_status', 'chk_model_evaluations_latency_nonneg'],
      replay_sessions: ['chk_replay_sessions_status', 'chk_replay_sessions_case_count_nonneg'],
      replay_results: ['chk_replay_results_decision', 'chk_replay_results_change_kind'],
      enforcement_modes: [
        'chk_enforcement_modes_mode',
        'chk_enforcement_modes_changed_by',
        'chk_enforcement_modes_protected_writes',
      ],
      vendors: ['chk_vendors_status', 'chk_vendors_account_age_nonneg', 'chk_vendors_verified_reference'],
      invoices: ['chk_invoices_amount_nonneg', 'chk_invoices_currency_shape', 'chk_invoices_document_untrusted'],
      purchase_orders: ['chk_purchase_orders_amount_nonneg', 'chk_purchase_orders_currency_shape'],
      connector_ledger: ['chk_connector_ledger_amount_nonneg', 'chk_connector_ledger_currency_shape'],
      connector_dispatches: ['chk_dispatches_completed'],
      mfa_secrets: ['chk_mfa_secrets_encrypted_shape'],
      legal_holds: [
        'chk_legal_holds_reason_nonempty',
        'chk_legal_holds_operator_nonempty',
        'chk_legal_holds_release_after_placement',
      ],
      retention_runs: ['chk_retention_runs_outcome', 'chk_retention_runs_counts_nonneg'],
    };
    for (const table of ALL_TABLES) {
      const name = getTableName(table);
      const live = await dbChecks(name);
      for (const check of expected[name] ?? []) {
        expect(live.has(check), `${name} missing CHECK ${check}`).toBe(true);
      }
      for (const found of live.keys()) {
        expect(expected[name], `${name} has unlisted CHECK ${found}; add it to this test`).toContain(found);
      }
    }
  });

  it('keeps enum CHECKs in sync with the domain enums', async () => {
    const cases: Array<{ table: string; check: string; values: readonly string[] }> = [
      { table: 'actions', check: 'chk_actions_state', values: Object.values(ActionState) },
      { table: 'actions', check: 'chk_actions_actor_type', values: Object.values(ActorType) },
      { table: 'actions', check: 'chk_actions_environment', values: Object.values(Environment) },
      { table: 'agents', check: 'chk_agents_status', values: Object.values(AgentStatus) },
      { table: 'agents', check: 'chk_agents_environment', values: Object.values(Environment) },
      { table: 'tenant_memberships', check: 'chk_membership_role', values: Object.values(Role) },
      { table: 'approvals', check: 'chk_approvals_decision', values: Object.values(ApprovalDecision) },
      { table: 'connectors', check: 'chk_connectors_status', values: Object.values(ConnectorStatus) },
      { table: 'connectors', check: 'chk_connectors_environment', values: Object.values(Environment) },
      { table: 'executions', check: 'chk_executions_state', values: Object.values(ExecutionState) },
      { table: 'audit_events', check: 'chk_audit_events_actor_type', values: Object.values(ActorType) },
      { table: 'outbox_events', check: 'chk_outbox_status', values: Object.values(OutboxStatus) },
      { table: 'policy_revisions', check: 'chk_policy_revisions_status', values: Object.values(PolicyRevisionStatus) },
      { table: 'enforcement_modes', check: 'chk_enforcement_modes_mode', values: Object.values(EnforcementMode) },
      { table: 'enforcement_modes', check: 'chk_enforcement_modes_changed_by', values: Object.values(ActorType) },
      { table: 'vendors', check: 'chk_vendors_status', values: Object.values(VendorStatus) },
      {
        table: 'outbox_events',
        check: 'chk_outbox_queue_name',
        values: ['pz.outbox', 'pz.model-analysis', 'pz.reconciliation', 'pz.replay', 'pz.dlq'],
      },
    ];
    for (const { table, check, values } of cases) {
      const def = (await dbChecks(table)).get(check);
      expect(def, `${table}.${check} exists`).toBeDefined();
      for (const value of values) {
        expect(def, `${table}.${check} contains ${value}`).toContain(value);
      }
    }
  });

  it('applies migrations idempotently and tracks them', async () => {
    await resetTestDb();
    const again = await migrate(db);
    expect(again.applied).toEqual([]);
    const rows = await db.sql<{ filename: string }[]>`SELECT filename FROM _migrations ORDER BY filename`;
    expect(rows.map((r) => r.filename)).toEqual([
      '0001_init.sql',
      '0002_triggers.sql',
      '0003_security_comments.sql',
      '0004_dispatches_outbox_queue.sql',
      '0005_credential_names_outbox_freeze.sql',
      '0006_row_level_security.sql',
      '0007_rls_write_scope.sql',
      '0008_mfa_totp.sql',
      '0009_encryption_at_rest.sql',
      '0010_retention_and_legal_hold.sql',
    ]);
  });
});
