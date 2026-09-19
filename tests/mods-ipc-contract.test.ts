import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

describe('mods/diff/skill-doctor IPC contract', () => {
  it('main registers all four channels', () => {
    const main = readFileSync(resolve(root, 'src/main/index.ts'), 'utf8');
    for (const channel of [
      "ipcMain.handle('mods.list'",
      "ipcMain.handle('mods.setEnabled'",
      "ipcMain.handle('diff.getSessionFiles'",
      "ipcMain.handle('skills.doctor'",
    ]) {
      expect(main).toContain(channel);
    }
    // No dynamic channel names.
    expect(main).not.toContain('ipcMain.handle(`mods');
  });

  it('preload declares the same channels and typed API', () => {
    const preload = readFileSync(resolve(root, 'src/preload/index.ts'), 'utf8');
    for (const channel of ["'mods.list'", "'mods.setEnabled'", "'diff.getSessionFiles'", "'skills.doctor'"]) {
      expect(preload).toContain(`ipcRenderer.invoke(${channel}`);
    }
    // API shape declared for the renderer.
    expect(preload).toContain('mods: {');
    expect(preload).toContain('diff: {');
    expect(preload).toContain('skillsDoctor:');
  });

  it('builtin mods are registered once at startup', () => {
    const main = readFileSync(resolve(root, 'src/main/index.ts'), 'utf8');
    expect(main).toContain('createBuiltinMods()');
    expect(main).toContain('modsRegistry.register(mod)');
  });

  it('agent-runner installs both pre and post mods hooks', () => {
    const runner = readFileSync(resolve(root, 'src/main/agent/agent-runner.ts'), 'utf8');
    expect(runner).toContain('runPreToolUse({ sessionId, toolName, args })');
    expect(runner).toContain('runPostToolUse(');
    expect(runner).toContain('setAfterToolCall');
    expect(runner).toContain('installModsHooks(piSession, session.id)');
  });

  it('every builtin mod id is unique', () => {
    const source = readFileSync(resolve(root, 'src/main/mods/builtin-mods.ts'), 'utf8');
    const ids = [...source.matchAll(/^  id: '([a-z-]+)',$/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('i18n keys exist in en, fr and zh with identical key sets', () => {
    const load = (lang: string): Record<string, unknown> =>
      JSON.parse(readFileSync(resolve(root, `src/renderer/i18n/locales/${lang}.json`), 'utf8'));
    for (const lang of ['en', 'fr', 'zh']) {
      const data = load(lang);
      expect(data.mods, `mods missing in ${lang}`).toBeTruthy();
      expect(data.diffPanel, `diffPanel missing in ${lang}`).toBeTruthy();
      expect(data.skillDoctor, `skillDoctor missing in ${lang}`).toBeTruthy();
    }
    const keySet = (o: Record<string, unknown>): Set<string> => new Set(Object.keys(o));
    for (const section of ['mods', 'diffPanel', 'skillDoctor']) {
      expect(keySet(load('fr')[section] as Record<string, unknown>)).toEqual(
        keySet(load('en')[section] as Record<string, unknown>)
      );
      expect(keySet(load('zh')[section] as Record<string, unknown>)).toEqual(
        keySet(load('en')[section] as Record<string, unknown>)
      );
    }
  });
});