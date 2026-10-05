/**
 * The host side of declarative mod UI (`ctx.ui`).
 *
 * A mod contributes DATA (nodes for a named slot); this host stores it,
 * validates it, and pushes the full list to the renderer whenever it changes.
 * The renderer draws the nodes with Cowork's own components — nothing a mod
 * ships is ever interpreted as markup.
 *
 * Two trust rules hold here, same as the rest of the v2 surface:
 *  - the contribution is validated on the way IN: a mod is code the user
 *    approved, but a malformed payload must not crash the renderer either;
 *  - the renderer is only trusted to report form values, and only addressed
 *    by (modId, nodeId) — never to contribute UI on a mod's behalf.
 *
 * Slot coverage is deliberately partial: only slots the app actually has a
 * host location for are rendered (`settingsTab`, in the mods settings
 * section). The other declared slots (`statusBar`, `messageActions`,
 * `sidePanel`) are accepted and stored, so mods can contribute them without
 * breaking, but no chrome exists to draw them yet.
 */

import type { ModUiContribution, ModUiNode, ModUiSlot } from '@cowork/mod-api';
import type { ContributedUiDto } from '../../../shared/mods-v2-contract';
import type { ModUiBackend } from './mod-context';

export const MOD_UI_SLOTS: readonly ModUiSlot[] = [
  'statusBar',
  'messageActions',
  'sidePanel',
  'settingsTab',
];

/** Same cap the renderer enforces — a mod cannot flood a slot. */
export const MAX_UI_CONTRIBUTION_NODES = 50;

/** Renderer-facing channel; declared in preload, sent with webContents.send. */
export const MODS_UI_CONTRIBUTIONS_CHANGED = 'modsV2.uiContributionsChanged';

const MAX_NODE_TEXT_CHARS = 2000;

function oversizedText(value: string): boolean {
  return value.length > MAX_NODE_TEXT_CHARS;
}

function isValidNode(node: unknown): node is ModUiNode {
  if (typeof node !== 'object' || node === null) return false;
  const candidate = node as Record<string, unknown>;
  switch (candidate.kind) {
    case 'text':
      return typeof candidate.label === 'string' && !oversizedText(candidate.label);
    case 'button':
      return (
        typeof candidate.id === 'string' &&
        typeof candidate.label === 'string' &&
        !oversizedText(candidate.label) &&
        (candidate.variant === undefined ||
          candidate.variant === 'primary' ||
          candidate.variant === 'ghost')
      );
    case 'list':
      return (
        typeof candidate.id === 'string' &&
        Array.isArray(candidate.items) &&
        candidate.items.every(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>).label === 'string' &&
            !oversizedText((item as Record<string, unknown>).label as string)
        )
      );
    case 'table':
      return (
        typeof candidate.id === 'string' &&
        Array.isArray(candidate.columns) &&
        candidate.columns.every((c) => typeof c === 'string') &&
        Array.isArray(candidate.rows) &&
        candidate.rows.every(
          (row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string')
        )
      );
    case 'form':
      return (
        typeof candidate.id === 'string' &&
        Array.isArray(candidate.fields) &&
        candidate.fields.every(
          (field) =>
            typeof field === 'object' &&
            field !== null &&
            typeof (field as Record<string, unknown>).id === 'string' &&
            typeof (field as Record<string, unknown>).label === 'string'
        )
      );
    default:
      // An unknown node kind is refused, not ignored loosely: the renderer's
      // switch treats it as `never`, so main must not forward it either.
      return false;
  }
}

export type ValidatedContribution =
  | { ok: true; contribution: ModUiContribution }
  | { ok: false; error: string };

/**
 * Validate a contribution before it enters the store. Pure and exported so the
 * acceptance/refusal table is unit-testable without Electron.
 */
export function validateContribution(input: unknown): ValidatedContribution {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'contribution is not an object' };
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.slot !== 'string' || !MOD_UI_SLOTS.includes(candidate.slot as ModUiSlot)) {
    return { ok: false, error: `unknown slot: ${String(candidate.slot)}` };
  }
  if (!Array.isArray(candidate.nodes)) {
    return { ok: false, error: 'nodes is not an array' };
  }
  if (candidate.nodes.length > MAX_UI_CONTRIBUTION_NODES) {
    return { ok: false, error: `too many nodes (max ${MAX_UI_CONTRIBUTION_NODES})` };
  }
  for (const node of candidate.nodes) {
    if (!isValidNode(node)) {
      return { ok: false, error: `invalid node: ${JSON.stringify(node)?.slice(0, 80) ?? ''}` };
    }
  }
  return {
    ok: true,
    contribution: { slot: candidate.slot as ModUiSlot, nodes: candidate.nodes as ModUiNode[] },
  };
}

export interface ModUiHostDeps {
  /**
   * Lazy web-contents accessor: the mods runtime starts before the window
   * exists, so the host must resolve it on every push, not at construction.
   */
  getWebContents: () => { send: (channel: string, payload: unknown) => void } | null;
}

export class ModUiHost implements ModUiBackend {
  private readonly byMod = new Map<string, ModUiContribution[]>();
  private readonly values = new Map<string, unknown>();

  constructor(private readonly deps: ModUiHostDeps) {}

  /**
   * Store a contribution. One contribution per (mod, slot): re-contributing
   * the same slot replaces the previous nodes, so a mod can refresh its UI
   * without accumulating copies.
   */
  async contribute(modId: string, contribution: ModUiContribution): Promise<void> {
    const checked = validateContribution(contribution);
    if (!checked.ok) {
      throw new Error(`[mod ${modId}] UI contribution refused: ${checked.error}`);
    }
    const kept = (this.byMod.get(modId) ?? []).filter((entry) => entry.slot !== checked.contribution.slot);
    this.byMod.set(modId, [...kept, checked.contribution]);
    this.push();
  }

  /** Surface a mod message to the renderer (toast is the renderer's job). */
  async notify(modId: string, message: string, level: 'info' | 'warn' | 'error'): Promise<void> {
    this.deps.getWebContents()?.send('modsV2.uiNotify', { modId, message, level });
  }

  /** A form value reported by the renderer, addressed to one mod node. */
  reportValue(modId: string, nodeId: string, value: unknown): void {
    this.values.set(valueKey(modId, nodeId), value);
  }

  /** What `ctx.ui.readValue` reads: the last value the user submitted. */
  async readValue(modId: string, nodeId: string): Promise<unknown> {
    return this.values.get(valueKey(modId, nodeId));
  }

  /** Full contribution list, for the initial render and every push. */
  list(): ContributedUiDto[] {
    const out: ContributedUiDto[] = [];
    for (const [modId, contributions] of this.byMod) {
      for (const contribution of contributions) {
        out.push({ modId, contribution });
      }
    }
    return out;
  }

  private push(): void {
    this.deps.getWebContents()?.send(MODS_UI_CONTRIBUTIONS_CHANGED, this.list());
  }
}

/** Composite key: the modId/nodeId pair is the whole address of a value. */
function valueKey(modId: string, nodeId: string): string {
  return `${modId}\n${nodeId}`;
}
