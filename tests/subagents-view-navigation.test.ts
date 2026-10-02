import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf-8');

/** Every source file under a directory (recursive). */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, out);
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('dedicated Sub-agents view navigation', () => {
  it('the duplicated SettingsSubAgents screen is gone for good', () => {
    // Regression: a second, drifted copy of the interface used to live inline
    // in the API tab.
    expect(
      existsSync(resolve(root, 'src/renderer/components/settings/SettingsSubAgents.tsx'))
    ).toBe(false);
    const panel = read('src/renderer/components/SettingsPanel.tsx');
    expect(panel).not.toContain('SettingsSubAgents');
  });

  it('Settings keeps ONE entry point that navigates to the dedicated view', () => {
    // Canonical surface decision (2026-09-22): the dedicated sidebar view is the
    // only place that RENDERS the interface. Settings keeps a tab, but it is a
    // link that navigates there — never a second host.
    const panel = read('src/renderer/components/SettingsPanel.tsx');
    expect(panel).not.toContain('<SubAgentsView');
    expect(panel).not.toContain("from './subagents/SubAgentsView'");
    expect(panel).toContain("id: 'subagents' as TabId");
    expect(panel).toContain("label: t('settings.subAgents')");
    // The sub-agents tab lives in the "Model" group. The group's exact tab list
    // is not what this test is about (presets joined that group later), so it
    // asserts membership rather than pinning the whole array.
    const modelGroup = /labelKey: 'settings\.groupModel', tabs: \[([^\]]*)\]/.exec(panel);
    expect(modelGroup, 'the Model tab group must exist').not.toBeNull();
    expect(modelGroup?.[1]).toContain("'subagents'");
    // The entry point navigates: it opens the dedicated view and closes Settings.
    expect(panel).toContain('setSubAgentsVisible(true)');
    expect(panel).toContain('onClose();');
    expect(panel).toContain("t('settings.subAgentsOpenView')");
  });

  it('renders the interface from exactly ONE place (the dedicated view)', () => {
    // Regression guard against a new "two hosts" drift: only App.tsx may render
    // the component. Any other render site fails this test.
    const renderSites = collectSources(resolve(root, 'src/renderer'))
      .filter((file) => readFileSync(file, 'utf-8').includes('<SubAgentsView'))
      .map((file) => file.slice(root.length + 1));
    expect(renderSites).toEqual(['src/renderer/App.tsx']);
  });

  it('the sidebar exposes a Sub-agents entry that opens the dedicated view', () => {
    const sidebar = read('src/renderer/components/Sidebar.tsx');
    expect(sidebar).toContain('handleOpenSubAgents');
    expect(sidebar).toContain('setSubAgentsVisible(true)');
    expect(sidebar).toContain("t('sidebar.subAgentsTitle')");
    // Collapsed rail keeps the entry reachable too.
    const railOccurrences = sidebar.split('handleOpenSubAgents').length - 1;
    expect(railOccurrences).toBeGreaterThanOrEqual(2);
  });

  it('App.tsx routes the dedicated view before sessions and projects pages', () => {
    const app = read('src/renderer/App.tsx');
    expect(app).toContain("import('./components/subagents/SubAgentsView')");
    const idxView = app.indexOf('subAgentsVisible ? (');
    const idxProjects = app.indexOf('projectsPage ? (');
    const idxSession = app.indexOf('activeSessionId ? (');
    expect(idxView).toBeGreaterThan(-1);
    expect(idxProjects).toBeGreaterThan(idxView);
    expect(idxSession).toBeGreaterThan(idxProjects);
    // Floating panels are hidden while the dedicated view is open.
    expect(app).toContain('!showSettings && !projectsPage && !subAgentsVisible && (');
  });

  it('the dedicated view hosts the pending-proposals section (Skill doctor parity)', () => {
    const view = read('src/renderer/components/subagents/SubAgentsView.tsx');
    // Same component the doctor renders — one implementation, two hosts.
    expect(view).toContain(
      "import { ProposedSkillsSection } from '../settings/SettingsSkillDoctor'"
    );
    expect(view).toContain('<ProposedSkillsSection />');
    const doctor = read('src/renderer/components/settings/SettingsSkillDoctor.tsx');
    expect(doctor).toContain('export function ProposedSkillsSection');
  });

  it('the dedicated view persists through the SAME config IPC as before', () => {
    const view = read('src/renderer/components/subagents/SubAgentsView.tsx');
    expect(view).toContain('window.electronAPI.config.get()');
    expect(view).toContain('subAgents: buildSubAgentsUpdate(draft)');
    expect(view).toContain('export function buildSubAgentsUpdate');
    expect(view).toContain('export function SubAgentsView');
  });

  it('i18n declares the sidebar + view strings in en AND fr', () => {
    const en = JSON.parse(read('src/renderer/i18n/locales/en.json')) as {
      sidebar: { subAgentsTitle: string };
      subAgentsView: { title: string };
    };
    const fr = JSON.parse(read('src/renderer/i18n/locales/fr.json')) as {
      sidebar: { subAgentsTitle: string };
      subAgentsView: { title: string };
    };
    expect(en.sidebar.subAgentsTitle).toBe('Sub-agents');
    expect(en.subAgentsView.title).toBe('Sub-agents');
    expect(fr.sidebar.subAgentsTitle).toBe('Sous-agents');
    expect(fr.subAgentsView.title).toBe('Sous-agents');
  });
});
