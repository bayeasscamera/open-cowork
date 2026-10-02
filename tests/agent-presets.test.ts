import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateAgentPreset,
  presetConsentReasons,
  MAX_PRESET_DELEGATION_DEPTH,
} from '../src/main/presets/preset-schema';
import {
  STANDARD_PRESET,
  CODE_MODE_PRESET,
  LONG_CONTEXT_PRESET,
  getBuiltinPreset,
  isBuiltinPresetId,
} from '../src/main/presets/builtin-presets';
import { loadPresets, findPreset } from '../src/main/presets/preset-loader';
import { resolvePreset } from '../src/main/presets/preset-resolver';

function validPreset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'my-preset',
    label: 'My preset',
    tools: { allow: ['read', 'bash'] },
    pruner: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
    delegation: { maxDepth: 1, allowFork: false },
    ...overrides,
  };
}

describe('preset schema — accepted shapes', () => {
  it('accepts a minimal valid preset and defaults presentation to direct', () => {
    const result = validateAgentPreset(validPreset());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preset.presentation).toBe('direct');
  });

  it('dedupes and sorts the tool allow-list', () => {
    const result = validateAgentPreset(validPreset({ tools: { allow: ['bash', 'read', 'bash'] } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preset.tools.allow).toEqual(['bash', 'read']);
  });
});

describe('preset schema — each constraint is enforced', () => {
  it('rejects unknown keys instead of ignoring a typo', () => {
    const result = validateAgentPreset(validPreset({ maxDepht: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/unrecognized|maxDepht/i);
  });

  it('rejects a head+tail budget that would not shorten anything', () => {
    const result = validateAgentPreset(
      validPreset({ pruner: { thresholdChars: 100, headChars: 60, tailChars: 60 } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/strictly less/);
  });

  it(`rejects maxDepth above ${MAX_PRESET_DELEGATION_DEPTH}`, () => {
    const result = validateAgentPreset(
      validPreset({ delegation: { maxDepth: MAX_PRESET_DELEGATION_DEPTH + 1, allowFork: false } })
    );
    expect(result.ok).toBe(false);
  });

  it('rejects maxRounds above the hard cap', () => {
    const result = validateAgentPreset(
      validPreset({ delegation: { maxDepth: 1, allowFork: false, maxRounds: 65 } })
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a wildcard tool list', () => {
    const result = validateAgentPreset(validPreset({ tools: { allow: ['*'] } }));
    expect(result.ok).toBe(false);
  });

  it('rejects tool names that are not lowercase snake_case', () => {
    const result = validateAgentPreset(validPreset({ tools: { allow: ['Read-File'] } }));
    expect(result.ok).toBe(false);
  });

  it('rejects an id that is not filesystem-safe', () => {
    for (const id of ['../escape', 'Upper', 'has space', '']) {
      expect(validateAgentPreset(validPreset({ id })).ok, id).toBe(false);
    }
  });

  it('rejects extraDirs that escape the preset directory', () => {
    for (const dir of ['../outside', '/etc', 'a/../../b']) {
      const result = validateAgentPreset(validPreset({ skills: { extraDirs: [dir] } }));
      expect(result.ok, dir).toBe(false);
    }
  });

  it('accepts a nested extraDir that stays inside', () => {
    const result = validateAgentPreset(
      validPreset({ skills: { extraDirs: ['skills/nested'] } })
    );
    expect(result.ok).toBe(true);
  });

  it('refuses to load a preset naming a tool that does not exist', () => {
    const result = validateAgentPreset(validPreset(), { knownTools: ['read'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain("'bash' is not a registered tool");
  });

  it('accepts a preset whose tools all exist in the registry', () => {
    expect(validateAgentPreset(validPreset(), { knownTools: ['read', 'bash'] }).ok).toBe(true);
  });
});

describe('built-in presets', () => {
  it('defaults to standard, direct presentation, no fork', () => {
    expect(STANDARD_PRESET.id).toBe('standard');
    expect(STANDARD_PRESET.presentation).toBe('direct');
    expect(STANDARD_PRESET.delegation.allowFork).toBe(false);
    expect(STANDARD_PRESET.pruner).toEqual({
      thresholdChars: 8192,
      headChars: 4096,
      tailChars: 1024,
    });
  });

  it('makes code-mode opt-in and long-context a much larger budget', () => {
    expect(CODE_MODE_PRESET.presentation).toBe('code');
    expect(LONG_CONTEXT_PRESET.pruner).toEqual({
      thresholdChars: 384000,
      headChars: 64000,
      tailChars: 64000,
    });
    // long-context keeps the same tools and stays direct.
    expect(LONG_CONTEXT_PRESET.presentation).toBe('direct');
  });

  it('identifies built-in ids', () => {
    expect(isBuiltinPresetId('standard')).toBe(true);
    expect(isBuiltinPresetId('nope')).toBe(false);
    expect(getBuiltinPreset('code-mode')?.id).toBe('code-mode');
  });

  it('flags presets needing explicit consent', () => {
    expect(presetConsentReasons(STANDARD_PRESET)).toEqual([]);
    expect(presetConsentReasons(CODE_MODE_PRESET).join(' ')).toContain('code mode');
    const forking = validateAgentPreset(
      validPreset({ delegation: { maxDepth: 1, allowFork: true } })
    );
    if (forking.ok) {
      expect(presetConsentReasons(forking.preset).join(' ')).toContain('fork');
    }
  });
});

describe('preset loader', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cowork-presets-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writePreset(id: string, data: unknown): void {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'preset.json'), JSON.stringify(data, null, 2));
  }

  it('returns only the built-ins when the presets directory does not exist', () => {
    const loaded = loadPresets({ root: join(root, 'missing') });
    expect(loaded.presets.map((p) => p.id)).toEqual(['standard', 'code-mode', 'long-context']);
    expect(loaded.issues).toEqual([]);
  });

  it('loads a well-formed user preset', () => {
    writePreset('my-preset', validPreset());
    const loaded = loadPresets({ root });
    expect(findPreset('my-preset', loaded)?.label).toBe('My preset');
    expect(loaded.issues).toEqual([]);
  });

  it('refuses corrupted JSON without losing the built-ins', () => {
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(join(root, 'broken', 'preset.json'), '{ not json');
    const loaded = loadPresets({ root });
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0].errors[0]).toMatch(/Invalid JSON/);
    expect(findPreset('standard', loaded)).toBeDefined();
  });

  it('refuses a user preset that shadows a built-in id', () => {
    writePreset('standard', validPreset({ id: 'standard' }));
    const loaded = loadPresets({ root });
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0].errors[0]).toMatch(/cannot use the built-in id/);
    // The built-in is untouched.
    expect(findPreset('standard', loaded)?.pruner.thresholdChars).toBe(8192);
  });

  it('refuses a preset whose id disagrees with its directory name', () => {
    writePreset('dir-name', validPreset({ id: 'other-id' }));
    const loaded = loadPresets({ root });
    expect(loaded.issues[0].errors[0]).toMatch(/does not match its directory name/);
  });

  it('refuses an extraDir that escapes via a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cowork-outside-'));
    const dir = join(root, 'sneaky');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'preset.json'),
      JSON.stringify(validPreset({ id: 'sneaky', skills: { extraDirs: ['link'] } }))
    );
    symlinkSync(outside, join(dir, 'link'), 'dir');

    const loaded = loadPresets({ root });
    expect(findPreset('sneaky', loaded)).toBeUndefined();
    expect(loaded.issues[0].errors.join(' ')).toMatch(/escapes|outside/);
    rmSync(outside, { recursive: true, force: true });
  });

  it('accepts an extraDir that stays inside the preset directory', () => {
    const dir = join(root, 'nested');
    mkdirSync(join(dir, 'skills', 'inner'), { recursive: true });
    writeFileSync(
      join(dir, 'preset.json'),
      JSON.stringify(validPreset({ id: 'nested', skills: { extraDirs: ['skills/inner'] } }))
    );
    const loaded = loadPresets({ root });
    expect(findPreset('nested', loaded)).toBeDefined();
    expect(loaded.issues).toEqual([]);
  });
});

describe('preset resolution order', () => {
  const loaded = loadPresets({ root: '/nonexistent-presets-dir' });

  it('falls back to standard with no pins at all', () => {
    const resolved = resolvePreset({ loaded });
    expect(resolved.preset.id).toBe('standard');
    expect(resolved.source).toBe('default');
  });

  it('lets a project pin win over the default', () => {
    const resolved = resolvePreset({ projectPresetId: 'long-context', loaded });
    expect(resolved.preset.id).toBe('long-context');
    expect(resolved.source).toBe('project');
  });

  it('lets a session override win over the project pin', () => {
    const resolved = resolvePreset({
      projectPresetId: 'long-context',
      sessionPresetId: 'code-mode',
      loaded,
    });
    expect(resolved.preset.id).toBe('code-mode');
    expect(resolved.source).toBe('session');
  });

  it('orders the sub-agent chain criticality > perRole > preset', () => {
    expect(
      resolvePreset({
        criticalityPresetId: 'code-mode',
        perRolePresetId: 'long-context',
        sessionPresetId: 'standard',
        loaded,
      })
    ).toMatchObject({ preset: { id: 'code-mode' }, source: 'criticality' });

    expect(
      resolvePreset({
        perRolePresetId: 'long-context',
        sessionPresetId: 'standard',
        loaded,
      })
    ).toMatchObject({ preset: { id: 'long-context' }, source: 'perRole' });

    expect(
      resolvePreset({ sessionPresetId: 'standard', loaded })
    ).toMatchObject({ preset: { id: 'standard' }, source: 'session' });
  });

  it('degrades an unknown id to standard with a warning instead of throwing', () => {
    const resolved = resolvePreset({ sessionPresetId: 'ghost', loaded });
    expect(resolved.preset.id).toBe('standard');
    expect(resolved.source).toBe('unknown-id');
    expect(resolved.warning).toContain('ghost');
  });
});

describe('regression: the default is off', () => {
  it('the standard preset is direct, does not fork, and never offers run_code', async () => {
    const { presentToolsForPreset, RUN_CODE_TOOL_NAME } = await import(
      '../src/main/presets/tool-presenter'
    );
    const tool = (name: string) =>
      ({
        name,
        description: '',
        inputSchema: { type: 'object', properties: {} },
        risk: 'read',
        execute: async () => ({ content: '' }),
      }) as never;

    const catalog = presentToolsForPreset(
      [tool('read_file'), tool(RUN_CODE_TOOL_NAME)],
      STANDARD_PRESET
    );

    // Direct presentation: nothing is hidden behind generated code, and the
    // model is never told a code entry point exists.
    expect(catalog.viaCode).toEqual([]);
    expect(catalog.sdkSource).toBe('');
    expect(STANDARD_PRESET.presentation).toBe('direct');
    expect(STANDARD_PRESET.delegation.allowFork).toBe(false);
    // run_code is absent from the standard allow-list, so it is filtered out
    // of the catalog entirely rather than merely presented directly.
    expect(STANDARD_PRESET.tools.allow).not.toContain(RUN_CODE_TOOL_NAME);
  });
});

describe('the shipped example preset is real, loadable data', () => {
  it('validates against the same strict schema the loader uses', () => {
    // Guards the example against rot: a commented-out or renamed field would
    // otherwise ship as documentation that silently fails to load.
    const raw = readFileSync('examples/presets/reviewer/preset.json', 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const result = validateAgentPreset(parsed, {
      knownTools: ['read', 'grep', 'glob', 'ls'],
    });
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
  });

  it('declares an id matching its directory, as the loader requires', () => {
    const parsed = JSON.parse(
      readFileSync('examples/presets/reviewer/preset.json', 'utf-8')
    ) as { id: string };
    expect(parsed.id).toBe('reviewer');
  });

  it('the example stays opt-in: no code mode, no fork', () => {
    const parsed = JSON.parse(
      readFileSync('examples/presets/reviewer/preset.json', 'utf-8')
    ) as { presentation: string; delegation: { allowFork: boolean } };
    expect(parsed.presentation).toBe('direct');
    expect(parsed.delegation.allowFork).toBe(false);
  });
});
