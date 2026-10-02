import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Phase 4: the preset's pruner budget and its extra skill directories must
 * reach the session WITHOUT changing the pre-preset behaviour when no preset is
 * pinned. The regression case that matters most is that last one: `standard`
 * must be a no-op.
 */

let electronRoot = '';
vi.mock('electron', () => ({
  app: {
    getPath: () => electronRoot,
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import { resolveActivePreset } from '../src/main/agent/preset-context';
import { validateAgentPreset } from '../src/main/presets/preset-schema';
import { loadPresets } from '../src/main/presets/preset-loader';
import { STANDARD_PRESET } from '../src/main/presets/builtin-presets';

beforeEach(() => {
  electronRoot = mkdtempSync(join(tmpdir(), 'cowork-preset-ctx-'));
});
afterEach(() => {
  rmSync(electronRoot, { recursive: true, force: true });
});

function writeUserPreset(id: string, data: unknown): void {
  const dir = join(electronRoot, 'presets', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify(data, null, 2));
}

function presetWithSkills(extraDirs: string[]) {
  const result = validateAgentPreset({
    id: 'with-skills',
    label: 'With skills',
    tools: { allow: ['read'] },
    pruner: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
    delegation: { maxDepth: 1, allowFork: false },
    skills: { extraDirs },
  });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.preset;
}

describe('pruner defaults preserve pre-preset behaviour', () => {
  it('leaves the compaction threshold unset so create-pi-session keeps 500', () => {
    // The historical threshold stays in create-pi-session as the fallback.
    // A preset that does not set it must not change it.
    expect(STANDARD_PRESET.pruner.compactionThresholdChars).toBeUndefined();
  });

  it('accepts an explicit compaction threshold', () => {
    const result = validateAgentPreset({
      id: 'loud',
      label: 'Loud',
      tools: { allow: ['read'] },
      pruner: {
        thresholdChars: 8192,
        headChars: 4096,
        tailChars: 1024,
        compactionThresholdChars: 4000,
      },
      delegation: { maxDepth: 1, allowFork: false },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preset.pruner.compactionThresholdChars).toBe(4000);
  });
});

describe('preset skill directories', () => {
  it('contributes extraDirs for the session when the preset is pinned', () => {
    writeUserPreset('with-skills', presetWithSkills(['extra']));
    mkdirSync(join(electronRoot, 'presets', 'with-skills', 'extra'), { recursive: true });

    const context = resolveActivePreset({ projectPresetId: 'with-skills' });
    expect(context.preset.id).toBe('with-skills');
    expect(context.extraSkillDirs).toHaveLength(1);
    expect(context.extraSkillDirs[0]).toContain('with-skills');
  });

  it('contributes nothing for the default preset', () => {
    const context = resolveActivePreset({});
    expect(context.preset.id).toBe('standard');
    expect(context.extraSkillDirs).toEqual([]);
  });

  it('does not duplicate a directory the session already discovered', () => {
    writeUserPreset('with-skills', presetWithSkills(['extra']));
    const extra = join(electronRoot, 'presets', 'with-skills', 'extra');
    mkdirSync(extra, { recursive: true });

    // The session already knows this directory: the preset must not add it
    // again, or the skill would be scanned twice.
    const context = resolveActivePreset({
      projectPresetId: 'with-skills',
      sessionSkillDirs: [extra],
    });
    expect(context.extraSkillDirs).toEqual([]);
  });

  it('is scoped to the session: a different session without the pin sees nothing', () => {
    writeUserPreset('with-skills', presetWithSkills(['extra']));
    mkdirSync(join(electronRoot, 'presets', 'with-skills', 'extra'), { recursive: true });

    const pinned = resolveActivePreset({ projectPresetId: 'with-skills' });
    const unpinned = resolveActivePreset({});
    expect(pinned.extraSkillDirs).toHaveLength(1);
    expect(unpinned.extraSkillDirs).toEqual([]);
  });

  it('skips a declared directory that does not exist rather than failing', () => {
    writeUserPreset('with-skills', presetWithSkills(['missing-dir']));
    const context = resolveActivePreset({ projectPresetId: 'with-skills' });
    expect(context.extraSkillDirs).toEqual([]);
    expect(context.preset.id).toBe('with-skills');
  });

  it('never exposes an extraDir that escaped the preset directory', () => {
    // Written as raw JSON on purpose: the schema already refuses this, and
    // the point of the test is that the LOADER is an independent backstop, so
    // the escape reaches the file without passing validation first.
    const dir = join(electronRoot, 'presets', 'sneaky');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'preset.json'),
      JSON.stringify({
        id: 'sneaky',
        label: 'Sneaky',
        tools: { allow: ['read'] },
        pruner: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        delegation: { maxDepth: 1, allowFork: false },
        skills: { extraDirs: ['../escape'] },
      })
    );

    const loaded = loadPresets();
    expect(loaded.presets.find((p) => p.id === 'sneaky')).toBeUndefined();
    expect(loaded.issues.some((i) => i.id === 'sneaky')).toBe(true);
  });
});
