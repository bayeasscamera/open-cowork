import { describe, expect, it } from 'vitest';
import {
  compareModBands,
  isEntryInsidePlugin,
  validateModManifest,
} from '../src/main/mods/v2/manifest-schema';

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'my-mod',
    name: 'My mod',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'dist/index.js',
    band: 'user',
    failMode: 'open',
    ...overrides,
  };
}

function pathsOf(result: ReturnType<typeof validateModManifest>): string[] {
  return result.ok ? [] : result.errors.map((error) => error.path);
}

describe('mod manifest — acceptance', () => {
  it('accepts a minimal manifest', () => {
    const result = validateModManifest(baseManifest());
    expect(result.ok).toBe(true);
  });

  it('accepts the full shape including declared capabilities', () => {
    const result = validateModManifest(
      baseManifest({
        events: ['onUserPrompt', 'onPreToolUse'],
        capabilities: {
          fs: { read: ['${workspace}'], write: [] },
          network: { domains: [] },
          ui: ['statusBar', 'messageActions'],
          storage: true,
          model: false,
        },
        author: 'Someone',
        homepage: 'https://example.invalid/mod',
      })
    );
    expect(result.ok).toBe(true);
  });

  it('accepts every band and both fail modes', () => {
    for (const band of ['system', 'org', 'user']) {
      expect(validateModManifest(baseManifest({ band })).ok).toBe(true);
    }
    for (const failMode of ['open', 'closed']) {
      expect(validateModManifest(baseManifest({ failMode })).ok).toBe(true);
    }
  });
});

describe('mod manifest — refusal', () => {
  it('rejects an unknown key instead of ignoring it', () => {
    // The whole point of strict: a typo must not silently fall back to a default.
    const result = validateModManifest(baseManifest({ capabilites: { storage: true } }));
    expect(result.ok).toBe(false);
  });

  it('rejects a nested unknown key under capabilities', () => {
    const result = validateModManifest(
      baseManifest({ capabilities: { fs: { read: ['/tmp'], delete: ['/'] } } })
    );
    expect(result.ok).toBe(false);
    expect(pathsOf(result).some((path) => path.includes('capabilities.fs'))).toBe(true);
  });

  it.each([
    ['uppercase id', 'My-Mod'],
    ['id with underscore', 'my_mod'],
    ['leading dash', '-my-mod'],
    ['empty id', ''],
  ])('rejects %s', (_label, id) => {
    expect(validateModManifest(baseManifest({ id })).ok).toBe(false);
  });

  it.each([
    ['missing patch', '1.0'],
    ['four segments', '1.0.0.1'],
    ['a range', '^1.0.0'],
    ['non-numeric', 'v1.0.0'],
  ])('rejects version %s', (_label, version) => {
    expect(validateModManifest(baseManifest({ version })).ok).toBe(false);
  });

  it('rejects an unsupported apiVersion rather than guessing', () => {
    expect(validateModManifest(baseManifest({ apiVersion: 2 })).ok).toBe(false);
  });

  it('rejects an unknown band', () => {
    expect(validateModManifest(baseManifest({ band: 'root' })).ok).toBe(false);
  });

  it('rejects an unknown failMode', () => {
    expect(validateModManifest(baseManifest({ failMode: 'maybe' })).ok).toBe(false);
  });

  it('rejects an unknown event name', () => {
    expect(validateModManifest(baseManifest({ events: ['onWhatever'] })).ok).toBe(false);
  });

  it('rejects a missing name', () => {
    const manifest = baseManifest();
    delete manifest.name;
    expect(validateModManifest(manifest).ok).toBe(false);
  });

  it('reports every issue at once rather than one per round-trip', () => {
    const result = validateModManifest({ id: 'BAD', version: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(1);
  });

  it('names the offending field', () => {
    const result = validateModManifest(baseManifest({ version: 'nope' }));
    expect(pathsOf(result)).toContain('version');
  });
});

describe('entry confinement', () => {
  it.each([
    ['parent traversal', '../../etc/passwd'],
    ['nested traversal', 'dist/../../outside.js'],
    ['backslash traversal', '..\\..\\windows\\system32'],
    ['absolute posix path', '/etc/passwd'],
    ['absolute windows path', 'C:\\windows\\system32\\x.js'],
    ['UNC path', '\\\\server\\share\\x.js'],
    ['NUL byte', 'dist/index.js\0.png'],
  ])('refuses %s', (_label, entry) => {
    expect(isEntryInsidePlugin(entry)).toBe(false);
    expect(validateModManifest(baseManifest({ entry })).ok).toBe(false);
  });

  it.each(['index.js', 'dist/index.js', './dist/index.js', 'dist/nested/deep.js'])(
    'accepts relative entry %s',
    (entry) => {
      expect(isEntryInsidePlugin(entry)).toBe(true);
    }
  );

  it('explains the refusal in the manifest error', () => {
    const result = validateModManifest(baseManifest({ entry: '../escape.js' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain('inside the plugin');
  });
});

describe('band ordering', () => {
  const manifestOf = (band: 'system' | 'org' | 'user') =>
    validateModManifest(baseManifest({ id: `mod-${band}`, band })) as {
      ok: true;
      manifest: import('@cowork/mod-api').ModManifest;
    };

  it('runs system before org before user', () => {
    const mods = [manifestOf('user').manifest, manifestOf('system').manifest, manifestOf('org').manifest];
    const sorted = [...mods].sort(compareModBands);
    expect(sorted.map((mod) => mod.band)).toEqual(['system', 'org', 'user']);
  });

  it('is stable inside a band', () => {
    const a = manifestOf('user').manifest;
    const b = manifestOf('user').manifest;
    expect(compareModBands(a, b)).toBe(0);
  });
});