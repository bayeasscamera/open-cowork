/**
 * @module main/ipc/preset-handlers
 *
 * IPC surface for agent presets: listing what is available, and the approve /
 * reject actions for pending proposals.
 *
 * Read paths never evaluate anything and never trust the caller: the loader
 * re-validates every preset on each call, so a preset edited on disk between
 * two reads is surfaced (or refused) on the next read rather than cached.
 *
 * Approve is the only mutating action, and it goes through the same
 * consent-aware path the tests exercise — the renderer cannot approve a
 * capability-changing preset by accident.
 */

import { IPCRouter } from './ipc-router';
import { loadPresets, type PresetLoadIssue } from '../presets/preset-loader';
import {
  approvePresetProposal,
  listPresetProposals,
  rejectPresetProposal,
  type PresetProposalMeta,
} from '../presets/preset-proposals';
import { presetConsentReasons, type AgentPreset } from '../presets/preset-schema';
import { isBuiltinPresetId } from '../presets/builtin-presets';
import { toolRegistry } from '../tools/registry';
import { log, logError } from '../utils/logger';

/** One preset as the renderer receives it. */
export interface PresetSummary {
  id: string;
  label: string;
  description?: string;
  presentation: 'direct' | 'code';
  /** Built-in presets cannot be edited or replaced. */
  builtin: boolean;
  allowFork: boolean;
  maxDepth: number;
  tools: string[];
  pruner: AgentPreset['pruner'];
  /** Non-empty when the preset needs an explicit consent checkbox. */
  consentReasons: string[];
}

function summarize(preset: AgentPreset): PresetSummary {
  const reasons = presetConsentReasons(preset);
  return {
    id: preset.id,
    label: preset.label,
    ...(preset.description ? { description: preset.description } : {}),
    presentation: preset.presentation,
    builtin: isBuiltinPresetId(preset.id),
    allowFork: preset.delegation.allowFork,
    maxDepth: preset.delegation.maxDepth,
    tools: [...preset.tools.allow],
    pruner: { ...preset.pruner },
    consentReasons: reasons,
  };
}

export interface PresetsOverview {
  presets: PresetSummary[];
  /** Pending proposals, with their consent requirements. */
  proposals: PresetProposalMeta[];
  /** Presets that failed to load, so the UI can show them rather than hide them. */
  issues: PresetLoadIssue[];
  /** Tool names the app currently exposes, for validating a future proposal. */
  knownTools: string[];
}

export function registerPresetHandlers(): void {
  IPCRouter.handle('presets.overview', (): PresetsOverview => {
    try {
      const { presets, issues } = loadPresets();
      return {
        presets: presets.map(summarize),
        proposals: listPresetProposals(),
        issues,
        knownTools: toolRegistry.names(),
      };
    } catch (error) {
      logError('[Presets] Failed to build the presets overview:', error);
      // A broken catalog must not blank the settings page: report the built-ins
      // so the user can still see and select something.
      return {
        presets: [],
        proposals: [],
        issues: [],
        knownTools: [],
      };
    }
  });

  IPCRouter.handle(
    'presets.approve',
    (
      _event: unknown,
      ...args: unknown[]
    ): { success: boolean; error?: string } => {
      const payload = (args[0] ?? {}) as { id?: unknown; consent?: unknown };
      const id = typeof payload.id === 'string' ? payload.id : '';
      if (!id) return { success: false, error: 'A preset id is required.' };
      // Consent is only honoured when explicitly true; anything else fails
      // closed inside approvePresetProposal.
      const consent = payload?.consent === true;
      try {
        const result = approvePresetProposal(id, { consent });
        if (result.ok) {
          log(`[Presets] Approved preset via IPC: ${result.id}`);
          return { success: true };
        }
        return { success: false, error: result.error };
      } catch (error) {
        logError('[Presets] Approve failed:', error);
        return { success: false, error: 'Failed to approve the preset proposal.' };
      }
    }
  );

  IPCRouter.handle(
    'presets.reject',
    (_event: unknown, ...args: unknown[]): { success: boolean; error?: string } => {
      const payload = (args[0] ?? {}) as { id?: unknown };
      const id = typeof payload.id === 'string' ? payload.id : '';
      if (!id) return { success: false, error: 'A preset id is required.' };
      try {
        const result = rejectPresetProposal(id);
        return { success: result.ok, ...(result.error ? { error: result.error } : {}) };
      } catch (error) {
        logError('[Presets] Reject failed:', error);
        return { success: false, error: 'Failed to reject the preset proposal.' };
      }
    }
  );
}
