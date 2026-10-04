import { describe, it, expect } from 'vitest';
import {
  BUILTIN_PRESET_IDS,
  FRONTEND_CRAFT_PRESET,
  getBuiltinPreset,
  isBuiltinPresetId,
  listBuiltinPresets,
} from '../src/main/presets/builtin-presets';

describe('FRONTEND_CRAFT_PRESET', () => {
  it('has the correct id and label', () => {
    expect(FRONTEND_CRAFT_PRESET.id).toBe('frontend-craft');
    expect(FRONTEND_CRAFT_PRESET.label).toBe('Frontend craft');
    expect(FRONTEND_CRAFT_PRESET.description).toContain('Impeccable');
  });

  it('is registered in BUILTIN_PRESET_IDS', () => {
    expect(BUILTIN_PRESET_IDS).toContain('frontend-craft');
  });

  it('is discoverable via getBuiltinPreset', () => {
    const p = getBuiltinPreset('frontend-craft');
    expect(p).toBeDefined();
    expect(p?.id).toBe('frontend-craft');
  });

  it('is recognised by isBuiltinPresetId', () => {
    expect(isBuiltinPresetId('frontend-craft')).toBe(true);
  });

  it('appears in listBuiltinPresets', () => {
    const all = listBuiltinPresets();
    const found = all.find((p) => p.id === 'frontend-craft');
    expect(found).toBeDefined();
  });

  it('uses direct presentation (not code mode)', () => {
    expect(FRONTEND_CRAFT_PRESET.presentation).toBe('direct');
  });

  it('injects a persona prefix that references the impeccable skill', () => {
    expect(FRONTEND_CRAFT_PRESET.persona?.prefix).toBeDefined();
    const prefix = FRONTEND_CRAFT_PRESET.persona!.prefix!;
    expect(prefix.toLowerCase()).toContain('impeccable');
    expect(prefix.toLowerCase()).toContain('design');
  });

  it('does not grant run_code (stays in the standard tool set)', () => {
    expect(FRONTEND_CRAFT_PRESET.tools.allow).not.toContain('run_code');
  });

  it('passes preset schema validation via freezePreset (no throw)', () => {
    // If freezePreset had thrown on construction, the module import itself
    // would have failed and none of the tests above would have passed.
    expect(FRONTEND_CRAFT_PRESET).toBeTruthy();
  });
});
