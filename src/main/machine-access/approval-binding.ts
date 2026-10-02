/**
 * @module main/machine-access/approval-binding
 *
 * Approval security properties (spec 2.4): the agent can never answer a card
 * for the user; approval binds to the EXACT action (command + paths
 * fingerprint) and expires quickly; dangerous actions are never grouped
 * with ordinary ones; any change between card and execution re-asks.
 */

import { createHash } from 'crypto';
import type { ApprovalBinding } from './types';
import type { MachineAction } from './risk-assessor';

export const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** Canonical form: sorted paths + exact command, no wildcards expansion. */
export function canonicalAction(action: MachineAction): string {
  const paths = [...(action.paths ?? [])].sort().join('|');
  return `${action.kind}::${action.command ?? ''}::${paths}::${action.batchSize ?? 0}::${action.elevated === true ? 'elev' : ''}`;
}

export function fingerprintAction(action: MachineAction): string {
  return createHash('sha256').update(canonicalAction(action), 'utf-8').digest('hex');
}

export function createBinding(action: MachineAction, now = Date.now()): ApprovalBinding {
  return {
    fingerprint: fingerprintAction(action),
    createdAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    singleAction: true,
  };
}

/** Valid only for the identical action, unexpired. Never transferable. */
export function isBindingValid(
  binding: ApprovalBinding,
  action: MachineAction,
  now = Date.now()
): boolean {
  if (now > binding.expiresAt) return false;
  if (binding.singleAction !== true) return false;
  return binding.fingerprint === fingerprintAction(action);
}
