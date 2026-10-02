/**
 * @module main/presets/preset-proposals
 *
 * The safe version of "self-modification": an agent may PROPOSE a preset, never
 * load one.
 *
 * A preset is pure data, so proposing one is not dangerous in itself. What
 * would be dangerous is a proposal taking effect: `presentation: 'code'` hands
 * the agent a code-execution path, and `allowFork` lets it spawn subtasks on the
 * parent's model. Both therefore require an explicit consent flag at approval
 * time, recorded on the proposal so the UI can show what is being consented to
 * rather than asking the user to trust a label.
 *
 * Mirrors the skill-proposal circuit (73c0ef7 / 22182c5 / ff5cc78) rather than
 * inventing a second one: pending drafts live in their own directory, are never
 * scanned as active presets, and only an explicit approval copies a file into
 * the user preset directory.
 *
 * The proposal directory is a SIBLING of the preset directory, not a child, so
 * a pending draft can never be picked up by the preset loader even if someone
 * hand-creates files there.
 */

import * as fs from 'fs';
import * as path from 'path';

import { presetsRoot } from './preset-loader';
import {
  presetConsentReasons,
  validateAgentPreset,
  type AgentPreset,
} from './preset-schema';
import { getBuiltinPreset } from './builtin-presets';
import { log, logError, logWarn } from '../utils/logger';

const PROPOSALS_DIRNAME = 'preset-proposals';
const PRESET_FILENAME = 'preset.json';
const META_FILENAME = 'proposal.json';

export interface PresetProposalMeta {
  id: string;
  proposedBy: string;
  proposedAt: number;
  version: number;
  rationale?: string;
  /** True when the preset needs an explicit consent checkbox to be approved. */
  requiresConsent: boolean;
  /** Why consent is required, so the UI can show the actual risk. */
  consentReasons: string[];
  /** The preset as proposed, for read-only display. */
  preset: AgentPreset;
}

export type ProposePresetResult =
  | { ok: true; id: string; version: number; requiresConsent: boolean }
  | { ok: false; error: string; errors?: string[] };

/** `<userData>/preset-proposals`, or null when there is no writable app dir. */
export function presetProposalsRoot(): string | null {
  const root = presetsRoot();
  if (!root) return null;
  // Sibling of <userData>/presets, NOT a child: pending drafts must never be
  // reachable by the preset loader.
  return path.join(path.dirname(root), PROPOSALS_DIRNAME);
}

/** Where an approved preset lands: `<userData>/presets/<id>/preset.json`. */
function approvedPresetPath(id: string): string | null {
  const root = presetsRoot();
  return root ? path.join(root, id, PRESET_FILENAME) : null;
}

/** Atomic write: temp file + rename in the same directory. */
function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Record a pending preset proposal.
 *
 * Validation is the same strict schema used at load time, so a proposal can
 * never contain something the loader would later refuse. A proposal whose id
 * collides with a BUILT-IN is refused outright: presets shipped with the app
 * are read-only, and an agent must not be able to redefine what "Standard"
 * means.
 */
export function proposePreset(input: {
  preset: unknown;
  proposedBy: string;
  rationale?: string;
  /** Tool names the registry actually knows, to validate tools.allow. */
  knownTools?: readonly string[];
}): ProposePresetResult {
  const root = presetProposalsRoot();
  if (!root) return { ok: false, error: 'No writable preset directory is available.' };

  const validated = validateAgentPreset(input.preset, {
    ...(input.knownTools ? { knownTools: input.knownTools } : {}),
  });
  if (!validated.ok) {
    return {
      ok: false,
      error: `The proposed preset is not valid: ${validated.errors[0]}`,
      errors: validated.errors,
    };
  }
  const preset = validated.preset;

  if (getBuiltinPreset(preset.id)) {
    return {
      ok: false,
      error:
        `'${preset.id}' is a built-in preset and cannot be replaced. Propose a new preset with a different id.`,
    };
  }

  // An already-APPROVED preset is also off limits: the agent may propose a
  // change, but it may not silently redefine a preset a human already chose.
  const approved = approvedPresetPath(preset.id);
  if (approved && fs.existsSync(approved)) {
    return {
      ok: false,
      error:
        `A user preset named '${preset.id}' already exists and is approved. ` +
        `Propose a new preset with a different id instead of replacing it.`,
    };
  }

  try {
    const dir = path.join(root, preset.id);
    fs.mkdirSync(dir, { recursive: true });

    const metaPath = path.join(dir, META_FILENAME);
    let version = 1;
    if (fs.existsSync(metaPath)) {
      try {
        const previous = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as PresetProposalMeta;
        version = (previous.version ?? 1) + 1;
      } catch {
        version = 1;
      }
    }

    const consentReasons = presetConsentReasons(preset);
    const meta: PresetProposalMeta = {
      id: preset.id,
      proposedBy: (input.proposedBy || 'sub-agent').slice(0, 120),
      proposedAt: Date.now(),
      version,
      ...(input.rationale?.trim() ? { rationale: input.rationale.trim().slice(0, 2000) } : {}),
      requiresConsent: consentReasons.length > 0,
      consentReasons,
      preset,
    };

    atomicWrite(path.join(dir, PRESET_FILENAME), JSON.stringify(preset, null, 2));
    atomicWrite(metaPath, JSON.stringify(meta, null, 2));
    log(
      `[PresetProposals] Proposed preset (v${version}, PENDING approval): ${preset.id}` +
        (consentReasons.length > 0 ? ` — requires consent: ${consentReasons.join(' ')}` : '')
    );
    return { ok: true, id: preset.id, version, requiresConsent: meta.requiresConsent };
  } catch (error) {
    logError('[PresetProposals] Failed to record proposal:', error);
    return { ok: false, error: 'Failed to write the preset proposal.' };
  }
}

function readMeta(dir: string): PresetProposalMeta | undefined {
  try {
    const metaPath = path.join(dir, META_FILENAME);
    if (!fs.existsSync(metaPath)) return undefined;
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as PresetProposalMeta;
  } catch {
    return undefined;
  }
}

/** Every pending proposal. The approved preset directory is never consulted. */
export function listPresetProposals(): PresetProposalMeta[] {
  const root = presetProposalsRoot();
  if (!root) return [];
  const out: PresetProposalMeta[] = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = readMeta(path.join(root, entry.name));
      if (meta) out.push(meta);
    }
  } catch (error) {
    logWarn('[PresetProposals] Could not list proposals:', error);
    return out;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getPresetProposal(id: string): PresetProposalMeta | undefined {
  return listPresetProposals().find((proposal) => proposal.id === id);
}

export type ApprovePresetResult =
  | { ok: true; id: string; path: string }
  | { ok: false; error: string };

/**
 * Copy an approved proposal into the user preset directory.
 *
 * Consent is required for a proposal that enables code mode or forking, and it
 * must be passed explicitly. Re-validating the stored preset at approval time
 * is deliberate: a draft on disk is not trusted just because it passed when it
 * was proposed.
 */
export function approvePresetProposal(
  id: string,
  options: { consent?: boolean } = {}
): ApprovePresetResult {
  const proposal = getPresetProposal(id);
  if (!proposal) return { ok: false, error: `No pending preset proposal named '${id}'.` };

  if (proposal.requiresConsent && options.consent !== true) {
    return {
      ok: false,
      error:
        `This preset needs explicit approval because it changes what the agent can do ` +
        `(${proposal.consentReasons.join(' ')}). Confirm to continue.`,
    };
  }

  // Re-validate: the file on disk is data, not a trusted artefact.
  const revalidated = validateAgentPreset(proposal.preset);
  if (!revalidated.ok) {
    return {
      ok: false,
      error: `The stored proposal no longer validates: ${revalidated.errors[0]}`,
    };
  }
  if (getBuiltinPreset(revalidated.preset.id)) {
    return { ok: false, error: `'${id}' is a built-in preset and cannot be replaced.` };
  }

  const target = approvedPresetPath(revalidated.preset.id);
  if (!target) return { ok: false, error: 'No writable preset directory is available.' };

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWrite(target, JSON.stringify(revalidated.preset, null, 2));
    // The draft is consumed: leaving it would let it be approved twice.
    fs.rmSync(path.dirname(path.join(presetProposalsRoot() ?? '', id)), {
      recursive: true,
      force: true,
    });
    log(`[PresetProposals] Approved preset (now selectable): ${revalidated.preset.id}`);
    return { ok: true, id: revalidated.preset.id, path: target };
  } catch (error) {
    logError('[PresetProposals] Failed to approve proposal:', error);
    return { ok: false, error: 'Failed to write the approved preset.' };
  }
}

/** Discard a proposal. Nothing is ever written to the preset directory. */
export function rejectPresetProposal(id: string): { ok: boolean; error?: string } {
  const root = presetProposalsRoot();
  if (!root) return { ok: false, error: 'No writable proposal directory is available.' };
  const dir = path.join(root, id);
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `No pending preset proposal named '${id}'.` };
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    log(`[PresetProposals] Rejected proposal: ${id}`);
    return { ok: true };
  } catch (error) {
    logError('[PresetProposals] Failed to reject proposal:', error);
    return { ok: false, error: 'Failed to remove the proposal.' };
  }
}

/** Test seam. */
export function __resetPresetProposalsForTest(): void {
  const root = presetProposalsRoot();
  if (!root) return;
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best-effort only.
  }
}
