'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { SendHorizonal } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldError,
  Input,
  Label,
  Textarea,
} from '@permitzero/ui';
import { ApiError, useIntake, useMe } from '@/lib/api';
import { RequestError } from '@/components/execution';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TOOL_META, TOOL_ORDER, type ToolFieldDef } from '@/lib/tools';
import { ToolBadge } from '@/components/badges';
import type { SupportedTool } from '@permitzero/schemas';

function randomSuffix(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: ToolFieldDef;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const id = `param-${field.name}`;
  const invalid = error !== undefined;
  if (field.kind === 'textarea') {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{field.label}</Label>
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          aria-invalid={invalid}
        />
        {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
        {error ? <FieldError>{error}</FieldError> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{field.label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        inputMode={field.kind === 'money' || field.kind === 'integer' ? 'decimal' : undefined}
        className="font-mono text-xs"
        aria-invalid={invalid}
      />
      {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

/** Coerce form strings into the typed arguments the API expects. Returns null on local errors. */
function buildArguments(
  fields: ToolFieldDef[],
  values: Record<string, string>,
): { args: Record<string, unknown> | null; errors: Record<string, string> } {
  const args: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const raw = (values[field.name] ?? '').trim();
    if (field.kind === 'optional-text') {
      args[field.name] = raw.length === 0 ? null : raw;
      continue;
    }
    if (raw.length === 0) {
      errors[field.name] = 'Required.';
      continue;
    }
    if (field.kind === 'money') {
      if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
        errors[field.name] = 'Enter an amount like 3000.00.';
        continue;
      }
      args[field.name] = Math.round(Number.parseFloat(raw) * 100);
      continue;
    }
    if (field.kind === 'integer') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        errors[field.name] = 'Enter a whole number of 1 or more.';
        continue;
      }
      args[field.name] = n;
      continue;
    }
    if (field.kind === 'currency') {
      args[field.name] = raw.toUpperCase();
      continue;
    }
    args[field.name] = raw;
  }
  return { args: Object.keys(errors).length === 0 ? args : null, errors };
}

export default function NewActionPage(): React.JSX.Element {
  const router = useRouter();
  const { me } = useMe();
  const intake = useIntake();
  const [tool, setTool] = React.useState<SupportedTool>('payment.execute');
  const [purpose, setPurpose] = React.useState('');
  const [agentId, setAgentId] = React.useState('');
  const [runId, setRunId] = React.useState('');
  const [environment, setEnvironment] = React.useState('DEMO');
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [topError, setTopError] = React.useState<unknown>(null);

  const isAgent = me?.actor_type === 'AGENT';
  React.useEffect(() => {
    if (isAgent && me) setAgentId(me.actor_id);
  }, [isAgent, me]);
  React.useEffect(() => {
    setRunId((prev) => (prev === '' ? `web-${randomSuffix()}` : prev));
    if (me) setEnvironment(me.environment);
  }, [me]);

  const meta = TOOL_META[tool];
  const setValue = (name: string, value: string): void => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const submit = (): void => {
    setTopError(null);
    const local: Record<string, string> = {};
    if (purpose.trim().length === 0) local['task_purpose'] = 'Say why this needs to happen.';
    if (agentId.trim().length === 0) local['agent_id'] = 'An agent is required.';
    if (runId.trim().length === 0) local['run_id'] = 'A run id is required.';
    const { args, errors } = buildArguments(meta.fields, values);
    const merged = { ...local, ...errors };
    setFieldErrors(merged);
    if (Object.keys(merged).length > 0 || !args) return;

    intake.mutate(
      {
        agent_id: agentId.trim(),
        run_id: runId.trim(),
        task_purpose: purpose.trim(),
        tool_name: tool,
        arguments: args,
        evidence_refs: [],
        idempotency_key: `web-${randomSuffix()}${randomSuffix()}`,
        environment,
      },
      {
        onSuccess: (res) => router.push(`/actions/${res.action_id}`),
        onError: (err) => {
          if (err instanceof ApiError && err.status === 422 && err.details) {
            const mapped: Record<string, string> = {};
            for (const [path, message] of Object.entries(err.details)) {
              const field = path.startsWith('arguments.') ? path.slice('arguments.'.length) : path;
              if (typeof message === 'string') mapped[field] = message;
            }
            if (Object.keys(mapped).length > 0) {
              setFieldErrors((prev) => ({ ...prev, ...mapped }));
              return;
            }
          }
          setTopError(err);
        },
      },
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New request</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe what should happen. Policy decides immediately; anything risky lands in the approval queue.
        </p>
      </div>

      <RequestError error={topError ?? intake.error} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            What should happen? <ToolBadge tool={tool} />
          </CardTitle>
          <CardDescription>{meta.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tool">Tool</Label>
            <Select
              value={tool}
              onValueChange={(v) => {
                setTool(v as SupportedTool);
                setValues({});
                setFieldErrors({});
              }}
            >
              <SelectTrigger id="tool">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TOOL_ORDER.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TOOL_META[t].label} — {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="purpose">Why does this need to happen?</Label>
            <Textarea
              id="purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="e.g. Pay the signed invoice for the March server hosting."
              rows={2}
              aria-invalid={fieldErrors['task_purpose'] !== undefined}
            />
            {fieldErrors['task_purpose'] ? <FieldError>{fieldErrors['task_purpose']}</FieldError> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>
            Only the fields this tool accepts. Everything is checked again on the server.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {meta.fields.map((field) => (
            <FieldInput
              key={field.name}
              field={field}
              value={values[field.name] ?? ''}
              error={fieldErrors[field.name]}
              onChange={(v) => setValue(field.name, v)}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>On whose behalf</CardTitle>
          <CardDescription>
            {isAgent
              ? 'Signed in as an agent, so requests go out under your own identity.'
              : 'Operators file requests for a registered agent. The agent must exist and be allowed to use this tool.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent">Agent ID</Label>
            <Input
              id="agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="agt_…"
              readOnly={isAgent}
              disabled={isAgent}
              className="font-mono text-xs"
              aria-invalid={fieldErrors['agent_id'] !== undefined}
            />
            {fieldErrors['agent_id'] ? <FieldError>{fieldErrors['agent_id']}</FieldError> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="run">Run ID</Label>
            <Input
              id="run"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              placeholder="web-…"
              className="font-mono text-xs"
              aria-invalid={fieldErrors['run_id'] !== undefined}
            />
            {fieldErrors['run_id'] ? <FieldError>{fieldErrors['run_id']}</FieldError> : null}
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="env">Environment</Label>
            <Select value={environment} onValueChange={setEnvironment}>
              <SelectTrigger id="env" className="sm:max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DEMO">Demo</SelectItem>
                <SelectItem value="STAGING">Staging</SelectItem>
                <SelectItem value="PRODUCTION">Production</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div>
        <Button onClick={submit} disabled={intake.isPending}>
          <SendHorizonal aria-hidden /> {intake.isPending ? 'Submitting…' : 'Submit for decision'}
        </Button>
      </div>
    </div>
  );
}
