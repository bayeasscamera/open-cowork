import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

describe('mods/diff/skill-doctor IPC contract', () => {
  it('main registers all four channels', () => {
    // mods.*/diff.* live in main/ipc/mods-handlers.ts and skills.doctor in
    // main/ipc/skills-handlers.ts since the structural refactor.
    const main = [
      readFileSync(resolve(root, 'src/main/index.ts'), 'utf8'),
      readFileSync(resolve(root, 'src/main/ipc/mods-handlers.ts'), 'utf8'),
      readFileSync(resolve(root, 'src/main/ipc/skills-handlers.ts'), 'utf8'),
    ].join('\n');
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
    for (const channel of [
      "'mods.list'",
      "'mods.setEnabled'",
      "'diff.getSessionFiles'",
      "'skills.doctor'",
    ]) {
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

  it('SettingsMods renders at the TOP of the Skills tab (discoverability)', () => {
    const panel = readFileSync(resolve(root, 'src/renderer/components/SettingsPanel.tsx'), 'utf8');
    const skillsTabStart = panel.indexOf("activeTab === 'skills' ? '' : 'hidden'");
    expect(skillsTabStart).toBeGreaterThan(-1);
    const modsPos = panel.indexOf('<SettingsMods />');
    const skillsPos = panel.indexOf('<SettingsSkills ');
    // Both must be inside the skills tab, mods BEFORE the skills list.
    expect(modsPos).toBeGreaterThan(skillsTabStart);
    expect(modsPos).toBeLessThan(skillsPos);
  });

  it('business skill is tender-and-funding-response, generalist format', () => {
    const skill = readFileSync(
      resolve(root, '.claude/skills/tender-and-funding-response/SKILL.md'),
      'utf8'
    );
    expect(skill.startsWith('---')).toBe(true);
    expect(skill).toContain('name: tender-and-funding-response');
    expect(skill).toContain('[À COMPLÉTER]');
    expect(skill).toMatch(/Jamais inventer/i);
    // The replaced drafts must be gone.
    expect(existsSync(resolve(root, '.claude/skills/dahira-admin-assistant'))).toBe(false);
    expect(existsSync(resolve(root, '.claude/skills/funding-dossier'))).toBe(false);
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
