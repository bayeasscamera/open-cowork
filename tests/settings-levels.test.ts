/**
 * Tests for the three-level (global -> project -> session) settings resolver.
 *
 * This module is the single source of truth shared by the agent runner and the
 * settings panel, so these tests pin the precedence rules, the provenance and
 * the degradation behaviour (unknown ConfigSet, empty install).
 */

import { describe, expect, it } from 'vitest';
import {
  resolveSettingsLadder,
  summarizeConfigSet,
  SETTINGS_LEVELS,
} from '../src/shared/settings-levels';

/**
 * Build a raw ConfigSet. Deliberately untyped so an extra (secret) profile
 * field can ride along and prove the resolver never copies it out.
 */
function set(id: string, over: { model?: string; name?: string } = {}) {
  return {
    id,
    name: over.name ?? id.toUpperCase(),
    provider: 'anthropic',
    activeProfileKey: 'anthropic',
    profiles: { anthropic: { model: over.model ?? 'claude-sonnet-4', apiKey: 'sk-secret' } },
  };
}

const TWO_SETS = [
  set('set-1', { name: 'Fast', model: 'claude-haiku' }),
  set('set-2', { name: 'Deep', model: 'claude-opus' }),
];

describe('summarizeConfigSet', () => {
  it('flattens the active profile', () => {
    expect(summarizeConfigSet(set('set-1', { name: 'Fast', model: 'claude-haiku' }))).toEqual({
      id: 'set-1',
      name: 'Fast',
      provider: 'anthropic',
      model: 'claude-haiku',
      baseUrl: undefined,
      contextWindow: undefined,
      maxTokens: undefined,
    });
  });

  it('falls back to the first profile when the active key is missing', () => {
    const summary = summarizeConfigSet({
      id: 'set-9',
      provider: 'openai',
      activeProfileKey: 'gemini',
      profiles: { openai: { model: 'gpt-5' } },
    });
    expect(summary.model).toBe('gpt-5');
  });

  it('falls back to the id when the set has no name', () => {
    expect(summarizeConfigSet({ id: 'set-3' }).name).toBe('set-3');
  });

  it('never carries credentials out of a ConfigSet', () => {
    const summary = summarizeConfigSet(set('set-1'));
    expect(JSON.stringify(summary)).not.toMatch(/api[-_]?key|sk-secret/i);
  });
});

describe('resolveSettingsLadder — baseline', () => {
  it('uses the globally active set when nothing is pinned', () => {
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: 'set-2', configSets: TWO_SETS },
    });
    expect(effective.configSetId).toBe('set-2');
    expect(effective.configSetName).toBe('Deep');
    expect(effective.model).toBe('claude-opus');
    expect(effective.configSetLevel).toBe('global');
    expect(effective.modelLevel).toBe('global');
    expect(effective.hasExplicitConfigSet).toBe(false);
    expect(effective.hasExplicitModel).toBe(false);
    expect(effective.warnings).toEqual([]);
  });

  it('exposes the ladder from lowest to highest precedence', () => {
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: 'set-1', configSets: TWO_SETS },
    });
    expect(effective.levels.map((level) => level.level)).toEqual(['global', 'project', 'session']);
    expect(SETTINGS_LEVELS).toEqual(['global', 'project', 'session']);
  });

  it('falls back to the first set when the active id no longer exists', () => {
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: 'deleted', configSets: TWO_SETS },
    });
    expect(effective.configSetId).toBe('set-1');
    expect(effective.warnings).toEqual([
      { code: 'unknown-config-set', level: 'global', value: 'deleted' },
    ]);
  });

  it('degrades cleanly when no ConfigSet exists at all', () => {
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: '', configSets: [] },
    });
    expect(effective.configSetId).toBe('');
    expect(effective.model).toBe('');
    expect(effective.warnings).toEqual([{ code: 'no-config-set', level: 'global' }]);
  });
});

describe('resolveSettingsLadder — precedence', () => {
  it('lets a project override the global set and its model', () => {
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: 'set-1', configSets: TWO_SETS },
      project: { id: 'p1', name: 'Cowork', configSetId: 'set-2', modelId: null },
    });
    expect(effective.configSetId).toBe('set-2');
    expect(effective.configSetLevel).toBe('project');
    expect(effective.model).toBe('claude-opus');
    expect(effective.hasExplicitConfigSet).toBe(true);
    expect(effective.levels.find((level) => level.level === 'project')?.decidesConfigSet).toBe(true);
    expect(effective.levels.find((level) => level.level === 'global')?.decidesConfigSet).toBe(false);
  });

  it('lets a session override the project set and model', () => {
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: 'set-1', configSets: TWO_SETS },
      project: { id: 'p1', name: 'Cowork', configSetId: 'set-1', modelId: null },
      session: { configSetId: 'set-2', modelId: 'claude-opus-preview' },
    });
    expect(effective.configSetId).toBe('set-2');
    expect(effective.configSetLevel).toBe('session');
    expect(effective.model).toBe('claude-opus-preview');
    expect(effective.modelLevel).toBe('session');
    expect(effective.hasExplicitConfigSet).toBe(true);
    expect(effective.hasExplicitModel).toBe(true);
  });

  it('applies a session model pin inside the project set', () => {
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: 'set-1', configSets: TWO_SETS },
      project: { id: 'p1', name: 'Cowork', configSetId: 'set-2', modelId: null },
      session: { configSetId: null, modelId: 'claude-opus-preview' },
    });
    expect(effective.configSetId).toBe('set-2');
    expect(effective.configSetLevel).toBe('project');
    expect(effective.modelLevel).toBe('session');
    expect(effective.model).toBe('claude-opus-preview');
  });

  it('honours a model pinned without a ConfigSet, inside the inherited set', () => {
    // Regression: this used to be silently ignored, because the runner only read
    // a model pin when a ConfigSet was pinned at the same level.
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: 'set-1', configSets: TWO_SETS },
      project: { id: 'p1', name: 'Cowork', configSetId: null, modelId: 'claude-haiku-preview' },
    });
    expect(effective.configSetId).toBe('set-1');
    expect(effective.model).toBe('claude-haiku-preview');
    expect(effective.modelLevel).toBe('project');
    expect(effective.hasExplicitModel).toBe(true);
  });

  it('treats blank and whitespace-only ids as inherit', () => {
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: 'set-1', configSets: TWO_SETS },
      project: { id: 'p1', name: 'Cowork', configSetId: '   ', modelId: '  ' },
      session: { configSetId: '', modelId: '   ' },
    });
    expect(effective.configSetId).toBe('set-1');
    expect(effective.model).toBe('claude-haiku');
    expect(effective.levels.every((level) => level.modelId === null)).toBe(true);
  });
});

describe('resolveSettingsLadder — degradation', () => {
  it('ignores an unknown session set AND its model pin', () => {
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: 'set-1', configSets: TWO_SETS },
      project: { id: 'p1', name: 'Cowork', configSetId: 'set-2', modelId: null },
      session: { configSetId: 'ghost', modelId: 'gpt-5' },
    });
    expect(effective.configSetId).toBe('set-2');
    expect(effective.model).toBe('claude-opus');
    expect(effective.warnings).toEqual([
      { code: 'unknown-config-set', level: 'session', value: 'ghost' },
    ]);
    const session = effective.levels.find((level) => level.level === 'session');
    expect(session?.ignored).toBe(true);
    expect(session?.configSetId).toBeNull();
    expect(session?.modelId).toBeNull();
    expect(session?.decidesConfigSet).toBe(false);
  });

  it('ignores an unknown project set but still honours the session', () => {
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: 'set-1', configSets: TWO_SETS },
      project: { id: 'p1', name: 'Cowork', configSetId: 'ghost', modelId: 'gpt-5' },
      session: { configSetId: 'set-2', modelId: null },
    });
    expect(effective.configSetId).toBe('set-2');
    expect(effective.warnings).toEqual([
      { code: 'unknown-config-set', level: 'project', value: 'ghost' },
    ]);
  });

  it('drops the model pin when no ConfigSet can be projected', () => {
    const effective = resolveSettingsLadder({
      global: { activeConfigSetId: '', configSets: [] },
      session: { configSetId: null, modelId: 'ghost-model' },
    });
    expect(effective.model).toBe('');
    expect(effective.hasExplicitModel).toBe(false);
  });
});
