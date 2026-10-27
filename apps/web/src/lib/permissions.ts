'use client';

import type { ActionDto, MeResponse } from '@permitzero/schemas';

/** Mirrors the server's approval gate for affordance display only. Routes enforce for real. */
export function canApprove(me: MeResponse | undefined): boolean {
  if (!me || me.actor_type !== 'USER') return false;
  return me.roles.some((r) => r === 'OWNER' || r === 'APPROVER');
}

/** Mirrors the server's spend gate for affordance display only. */
export function canSpend(me: MeResponse | undefined, action: ActionDto): boolean {
  if (!me) return false;
  if (me.actor_type === 'WORKER') return true;
  if (me.actor_type === 'AGENT') return me.actor_id === action.agent_id;
  if (me.actor_type === 'USER') {
    return me.roles.some((r) => r === 'OWNER' || r === 'OPERATOR' || r === 'APPROVER');
  }
  return false;
}
