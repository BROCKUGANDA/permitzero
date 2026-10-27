'use client';

import * as React from 'react';
import { Button, FieldError, Input, Label, Textarea, Alert } from '@permitzero/ui';
import { ApiError, useApprove, useReject } from '@/lib/api';
import { shortHash } from '@/lib/format';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import type { ActionDto } from '@permitzero/schemas';

const REASONS: Array<{ value: string; label: string }> = [
  { value: 'EVIDENCE_REVIEWED', label: 'I reviewed the evidence' },
  { value: 'PO_CONFIRMED', label: 'Purchase order confirmed' },
  { value: 'VENDOR_VERIFIED_OUT_OF_BAND', label: 'Verified with the vendor directly' },
  { value: 'EXCEPTION_GRANTED', label: 'Granted as an exception' },
  { value: 'RISK_ACCEPTED_WITH_CONDITIONS', label: 'Risk accepted with conditions' },
  { value: 'DUPLICATE_SUSPECTED', label: 'Looks like a duplicate' },
  { value: 'BENEFICIARY_UNVERIFIED', label: 'Destination not verified' },
  { value: 'AMOUNT_UNJUSTIFIED', label: 'Amount not justified' },
  { value: 'POLICY_MISCONFIGURED', label: 'Policy looks misconfigured' },
  { value: 'INSUFFICIENT_EVIDENCE', label: 'Not enough evidence' },
  { value: 'REQUESTER_NOT_AUTHORISED', label: 'Requester not authorised' },
  { value: 'OTHER', label: 'Other (explain below)' },
];

function idempotencyKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `web-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function DecisionError({ error }: { error: unknown }): React.JSX.Element | null {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
  return (
    <Alert variant="destructive" title="Decision not recorded">
      {message}
    </Alert>
  );
}

export function ApproveDialog({ action }: { action: ActionDto }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('EVIDENCE_REVIEWED');
  const [note, setNote] = React.useState('');
  const [mfaRef, setMfaRef] = React.useState('');
  const approve = useApprove();

  const submit = (): void => {
    approve.mutate(
      {
        actionId: action.action_id,
        body: {
          decision: 'APPROVE',
          reason_code: reason,
          ...(note.trim() ? { reason_text: note.trim() } : {}),
          idempotency_key: idempotencyKey(),
          action_hash: action.action_hash,
          policy_revision_id: action.policy_revision_id ?? '',
          ...(mfaRef.trim() ? { mfa_context_ref: mfaRef.trim() } : {}),
        },
      },
      { onSuccess: () => setOpen(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Approve</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve this action</DialogTitle>
          <DialogDescription>
            You are approving exactly what you see: request{' '}
            <span className="font-mono">{shortHash(action.action_hash)}</span> under policy revision{' '}
            {action.policy_revision_number ?? '—'}. If anything changes, your approval stops applying.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="approve-reason">Basis for approval</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger id="approve-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONS.filter(
                  (r) =>
                    ![
                      'DUPLICATE_SUSPECTED',
                      'BENEFICIARY_UNVERIFIED',
                      'AMOUNT_UNJUSTIFIED',
                      'POLICY_MISCONFIGURED',
                      'INSUFFICIENT_EVIDENCE',
                      'REQUESTER_NOT_AUTHORISED',
                    ].includes(r.value),
                ).map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {action.approval_progress?.requires_mfa ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="approve-mfa">Step-up authentication reference</Label>
              <Input
                id="approve-mfa"
                value={mfaRef}
                onChange={(e) => setMfaRef(e.target.value)}
                placeholder="From your authenticator ceremony"
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="approve-note">Note (optional)</Label>
            <Textarea
              id="approve-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything the record should keep"
            />
          </div>
          <DecisionError error={approve.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={approve.isPending}>
            {approve.isPending ? 'Recording…' : 'Record approval'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RejectDialog({ action }: { action: ActionDto }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('AMOUNT_UNJUSTIFIED');
  const [note, setNote] = React.useState('');
  const [confirmError, setConfirmError] = React.useState<string | null>(null);
  const reject = useReject();

  const submit = (): void => {
    if (reason === 'OTHER' && note.trim().length === 0) {
      setConfirmError('Explain the rejection in the note when choosing “Other”.');
      return;
    }
    setConfirmError(null);
    reject.mutate(
      {
        actionId: action.action_id,
        body: {
          decision: 'REJECT',
          reason_code: reason,
          ...(note.trim() ? { reason_text: note.trim() } : {}),
          idempotency_key: idempotencyKey(),
        },
      },
      { onSuccess: () => setOpen(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive">Reject</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject this action</DialogTitle>
          <DialogDescription>
            Rejection is final and immediate — one rejection stops the action. The requester will see your reason.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reject-reason">Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger id="reject-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reject-note">Note{reason === 'OTHER' ? '' : ' (optional)'}</Label>
            <Textarea
              id="reject-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What should change before this comes back?"
            />
          </div>
          {confirmError ? <FieldError>{confirmError}</FieldError> : null}
          <DecisionError error={reject.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={reject.isPending}>
            {reject.isPending ? 'Recording…' : 'Record rejection'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
