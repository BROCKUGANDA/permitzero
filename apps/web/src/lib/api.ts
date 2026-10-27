'use client';

/**
 * Typed API client. Responses validate against the shared contract schemas,
 * so a drifting backend fails loudly here instead of rendering half-truths.
 * Requests go same-origin (/api/*) and the Next server rewrites them to the
 * API, which keeps browser CORS out of the picture entirely.
 */
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  actionDtoSchema,
  createActionResponseSchema,
  executeActionResponseSchema,
  meSchema,
  pageSchema,
  permitDtoSchema,
  statusSchema,
  type ActionDto,
  type CreateActionResponse,
  type ExecuteActionResponse,
  type MeResponse,
  type PermitDto,
  type StatusResponse,
} from '@permitzero/schemas';
import { useAuth } from './auth';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | null;
  readonly traceId: string | null;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, opts?: { details?: unknown; traceId?: unknown; retryable?: unknown }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = typeof opts?.details === 'object' && opts.details !== null ? (opts.details as Record<string, unknown>) : null;
    this.traceId = typeof opts?.traceId === 'string' ? opts.traceId : null;
    this.retryable = opts?.retryable === true;
  }
}

/** Wire keys that always carry datetimes; revived before schema validation. */
const DATE_KEYS = new Set([
  'requested_at',
  'expires_at',
  'checked_at',
  'decided_at',
  'created_at',
  'updated_at',
  'issued_at',
  'completed_at',
  'dispatch_started_at',
  'result_received_at',
  'last_used_at',
  'revoked_at',
  'consumed_at',
  'mfa_enrolled_at',
  'last_login_at',
  'credential_expires_at',
  'mfa_verified_at',
]);

function reviveDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveDates);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (DATE_KEYS.has(key) && typeof entry === 'string') {
      const parsed = new Date(entry);
      out[key] = Number.isNaN(parsed.getTime()) ? entry : parsed;
    } else {
      out[key] = reviveDates(entry);
    }
  }
  return out;
}

export interface FetchOpts {
  token: string | null;
  method?: 'GET' | 'POST';
  body?: unknown;
}

export async function apiFetch<T>(path: string, schema: z.ZodType<T>, opts: FetchOpts): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const envelope = (json as { error?: { code?: unknown; message?: unknown; details?: unknown; trace_id?: unknown; retryable?: unknown } } | null)?.error;
    throw new ApiError(
      res.status,
      typeof envelope?.code === 'string' ? envelope.code : 'UNKNOWN',
      typeof envelope?.message === 'string' ? envelope.message : `Request failed (${res.status}).`,
      { details: envelope?.details, traceId: envelope?.trace_id, retryable: envelope?.retryable },
    );
  }
  return schema.parse(reviveDates(json));
}

const actionPageSchema = pageSchema(actionDtoSchema);
export type ActionPage = z.infer<typeof actionPageSchema>;

export const queryKeys = {
  me: ['me'],
  status: ['status'],
  actions: (filters: Record<string, string>, cursor: string | null) => ['actions', filters, cursor],
  action: (id: string) => ['action', id],
};

export function useMe(): { me: MeResponse | undefined; error: unknown; isLoading: boolean } {
  const { token } = useAuth();
  const query = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => apiFetch('/v1/me', meSchema, { token }),
    enabled: token !== null,
    retry: false,
    staleTime: 60_000,
  });
  return { me: query.data, error: query.error, isLoading: query.isLoading };
}

export function useStatus(): { status: StatusResponse | undefined; error: unknown; isLoading: boolean } {
  const { token } = useAuth();
  const query = useQuery({
    queryKey: queryKeys.status,
    queryFn: () => apiFetch('/v1/status', statusSchema, { token }),
    enabled: token !== null,
    retry: 1,
    refetchInterval: 15_000,
  });
  return { status: query.data, error: query.error, isLoading: query.isLoading };
}

export interface ActionFilters {
  state?: string;
  tool_name?: string;
  agent_id?: string;
  run_id?: string;
}

const TERMINAL_STATES = new Set([
  'SUCCEEDED',
  'FAILED_TERMINAL',
  'DENIED',
  'REJECTED',
  'EXPIRED',
  'REVOKED',
  'MANUAL_REVIEW',
  'QUARANTINED',
]);

export function useAction(id: string): { action: ActionDto | undefined; error: unknown; isLoading: boolean; refetch: () => void } {
  const { token } = useAuth();
  const query = useQuery({
    queryKey: queryKeys.action(id),
    queryFn: () => apiFetch(`/v1/actions/${id}`, actionDtoSchema, { token }),
    enabled: token !== null && id.length > 0,
    retry: 1,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      return state === undefined || TERMINAL_STATES.has(state) ? false : 5_000;
    },
  });
  return { action: query.data, error: query.error, isLoading: query.isLoading, refetch: () => void query.refetch() };
}

export function useActions(
  filters: ActionFilters,
  cursor: string | null,
): { page: ActionPage | undefined; error: unknown; isLoading: boolean } {
  const { token } = useAuth();
  const params = new URLSearchParams({ limit: '25' });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  if (cursor) params.set('cursor', cursor);
  const serialized: Record<string, string> = {};
  params.forEach((value, key) => {
    serialized[key] = value;
  });
  const query = useQuery({
    queryKey: queryKeys.actions(serialized, cursor),
    queryFn: () => apiFetch(`/v1/actions?${params.toString()}`, actionPageSchema, { token }),
    enabled: token !== null,
    retry: 1,
    placeholderData: keepPreviousData,
  });
  return { page: query.data, error: query.error, isLoading: query.isLoading };
}

function useAuthedMutation<TData, TVariables>(fn: (token: string | null, variables: TVariables) => Promise<TData>) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: TVariables) => fn(token, variables),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      void queryClient.invalidateQueries({ queryKey: ['action'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
    },
  });
}

export function useIntake(): ReturnType<typeof useAuthedMutation<CreateActionResponse, Record<string, unknown>>> {
  return useAuthedMutation((token, body) =>
    apiFetch('/v1/actions', createActionResponseSchema, { token, method: 'POST', body }),
  );
}

export interface DecisionInput {
  actionId: string;
  body: Record<string, unknown>;
}

export function useApprove(): ReturnType<typeof useAuthedMutation<ActionDto, DecisionInput>> {
  return useAuthedMutation((token, { actionId, body }) =>
    apiFetch(`/v1/actions/${actionId}/approve`, actionDtoSchema, { token, method: 'POST', body }),
  );
}

export function useReject(): ReturnType<typeof useAuthedMutation<ActionDto, DecisionInput>> {
  return useAuthedMutation((token, { actionId, body }) =>
    apiFetch(`/v1/actions/${actionId}/reject`, actionDtoSchema, { token, method: 'POST', body }),
  );
}

export function useCollect(): ReturnType<typeof useAuthedMutation<PermitDto, string>> {
  return useAuthedMutation((token, actionId) =>
    apiFetch(`/v1/actions/${actionId}/permit`, permitDtoSchema, { token, method: 'POST', body: {} }),
  );
}

export function useExecute(): ReturnType<typeof useAuthedMutation<ExecuteActionResponse, DecisionInput>> {
  return useAuthedMutation((token, { actionId, body }) =>
    apiFetch(`/v1/actions/${actionId}/execute`, executeActionResponseSchema, { token, method: 'POST', body }),
  );
}
