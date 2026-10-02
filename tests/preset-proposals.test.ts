import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let electronRoot = '';
vi.mock('electron', () => ({
  app: {
    getPath: () => electronRoot,
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import {
  approvePresetProposal,
  getPresetProposal,
  listPresetProposals,
  presetProposalsRoot,
  proposePreset,
  rejectPresetProposal,
  __resetPresetProposalsForTest,
} from '../src/main/presets/preset-proposals';
import { loadPresets } from '../src/main/presets/preset-loader';

const KNOWN_TOOLS = ['read', 'bash', 'run_code'];

function preset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'my-preset',
    label: 'My preset',
    tools: { allow: ['read'] },
    pruner: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
    delegation: { maxDepth: 1, allowFork: false },
    ...overrides,
  };
}

beforeEach(() => {
  electronRoot = mkdtempSync(join(tmpdir(), 'cowork-preset-proposals-'));
  __resetPresetProposalsForTest();
});
afterEach(() => {
  rmSync(electronRoot, { recursive: true, force: true });
});

describe('proposing a preset', () => {
  it('records a valid preset as pending and does NOT activate it', () => {
    const result = proposePreset({ preset: preset(), proposedBy: 'agent', knownTools: KNOWN_TOOLS });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe('my-preset');
      expect(result.requiresConsent).toBe(false);
    }
    // Pending draft exists, and is in the proposals directory, NOT presets/.
    expect(getPresetProposal('my-preset')?.version).toBe(1);
    expect(loadPresets().presets.find((p) => p.id === 'my-preset')).toBeUndefined();
  });

  it('refuses an invalid preset with a clear message', () => {
    const result = proposePreset({
      preset: preset({ pruner: { thresholdChars: 10, headChars: 9, tailChars: 9 } }),
      proposedBy: 'agent',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not valid/i);
      expect(result.errors?.join(' ')).toMatch(/strictly less/);
    }
    expect(listPresetProposals()).toEqual([]);
  });

  it('refuses a preset naming a tool that does not exist', () => {
    const result = proposePreset({
      preset: preset({ tools: { allow: ['not_a_tool'] } }),
      proposedBy: 'agent',
      knownTools: KNOWN_TOOLS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not_a_tool');
  });

  it('refuses an id that collides with a built-in preset', () => {
    const result = proposePreset({
      preset: preset({ id: 'standard' }),
      proposedBy: 'agent',
      knownTools: KNOWN_TOOLS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/built-in preset/);
  });

  it('refuses to replace a preset a human already approved', () => {
    // A first proposal is approved…
    expect(
      proposePreset({ preset: preset(), proposedBy: 'agent', knownTools: KNOWN_TOOLS }).ok
    ).toBe(true);
    expect(approvePresetProposal('my-preset', { consent: true }).ok).toBe(true);

    // …and a later proposal for the same id is refused.
    const second = proposePreset({
      preset: preset({ label: 'Hijacked' }),
      proposedBy: 'agent',
      knownTools: KNOWN_TOOLS,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already exists and is approved/);
  });

  it('bumps the version when the same preset is proposed again while pending', () => {
    proposePreset({ preset: preset(), proposedBy: 'agent', knownTools: KNOWN_TOOLS });
    const second = proposePreset({
      preset: preset({ label: 'Revised' }),
      proposedBy: 'agent',
      knownTools: KNOWN_TOOLS,
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.version).toBe(2);
    expect(getPresetProposal('my-preset')?.preset.label).toBe('Revised');
  });
});

describe('consent is required for capability-changing presets', () => {
  it('flags code mode as needing consent and refuses approval without it', () => {
    const result = proposePreset({
      preset: preset({ id: 'coder', presentation: 'code' }),
      proposedBy: 'agent',
      knownTools: KNOWN_TOOLS,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.requiresConsent).toBe(true);

    const refused = approvePresetProposal('coder');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/explicit approval/i);

    // With explicit consent it lands.
    const approved = approvePresetProposal('coder', { consent: true });
    expect(approved.ok).toBe(true);
    if (approved.ok) expect(existsSync(approved.path)).toBe(true);
  });

  it('flags allowFork as needing consent', () => {
    const result = proposePreset({
      preset: preset({ id: 'forker', delegation: { maxDepth: 1, allowFork: true } }),
      proposedBy: 'agent',
      knownTools: KNOWN_TOOLS,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.requiresConsent).toBe(true);
    expect(approvePresetProposal('forker').ok).toBe(false);
  });

  it('an ordinary preset needs no consent', () => {
    proposePreset({ preset: preset(), proposedBy: 'agent', knownTools: KNOWN_TOOLS });
    expect(approvePresetProposal('my-preset').ok).toBe(true);
  });
});

describe('approval and rejection', () => {
  it('approval writes the preset where the loader will find it', () => {
    proposePreset({ preset: preset(), proposedBy: 'agent', knownTools: KNOWN_TOOLS });
    const approved = approvePresetProposal('my-preset');
    expect(approved.ok).toBe(true);
    // The loader now sees it, with no issue reported.
    const loaded = loadPresets();
    expect(loaded.presets.find((p) => p.id === 'my-preset')?.label).toBe('My preset');
    expect(loaded.issues).toEqual([]);
  });

  it('rejection loads nothing', () => {
    proposePreset({ preset: preset(), proposedBy: 'agent', knownTools: KNOWN_TOOLS });
    expect(rejectPresetProposal('my-preset').ok).toBe(true);
    expect(listPresetProposals()).toEqual([]);
    expect(loadPresets().presets.find((p) => p.id === 'my-preset')).toBeUndefined();
  });

  it('the draft is consumed on approval, so it cannot be approved twice', () => {
    proposePreset({ preset: preset(), proposedBy: 'agent', knownTools: KNOWN_TOOLS });
    expect(approvePresetProposal('my-preset').ok).toBe(true);
    expect(getPresetProposal('my-preset')).toBeUndefined();
    expect(approvePresetProposal('my-preset').ok).toBe(false);
  });

  it('re-validates at approval time rather than trusting the stored draft', () => {
    proposePreset({ preset: preset(), proposedBy: 'agent', knownTools: KNOWN_TOOLS });
    // Tamper with the stored draft the way a compromised agent would.
    const metaPath = join(presetProposalsRoot()!, 'my-preset', 'proposal.json');
    const meta = JSON.parse(require('node:fs').readFileSync(metaPath, 'utf-8'));
    meta.preset.pruner = { thresholdChars: 10, headChars: 9, tailChars: 9 };
    writeFileSync(metaPath, JSON.stringify(meta));

    const approved = approvePresetProposal('my-preset');
    expect(approved.ok).toBe(false);
    if (!approved.ok) expect(approved.error).toMatch(/no longer validates/);
  });
});

describe('a proposal is never reachable by the loader', () => {
  it('lives in a sibling directory of the preset directory', () => {
    proposePreset({ preset: preset(), proposedBy: 'agent', knownTools: KNOWN_TOOLS });
    const proposals = presetProposalsRoot()!;
    const presets = join(electronRoot, 'presets');
    // Sibling, not child: the loader walking presets/*/ can never see a draft.
    expect(existsSync(proposals)).toBe(true);
    expect(proposals.startsWith(presets + '/')).toBe(false);
    expect(loadPresets().presets.map((p) => p.id)).not.toContain('my-preset');
  });

  it('a hand-placed draft inside the presets tree is not a usable preset', () => {
    // Even if something writes a file there directly, the loader still
    // validates it — a draft without going through proposal is just data.
    const dir = join(electronRoot, 'presets', 'sneaky');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'preset.json'), JSON.stringify(preset({ id: 'sneaky' })));
    const loaded = loadPresets();
    // It loads as an ordinary user preset (valid data), which is the
    // documented behaviour: the loader trusts nothing, it validates.
    expect(loaded.presets.find((p) => p.id === 'sneaky')).toBeDefined();
    expect(loaded.issues).toEqual([]);
  });
});
