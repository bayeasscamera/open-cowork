import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf-8');

describe('dedicated Sub-agents view navigation', () => {
  it('the duplicated SettingsSubAgents screen is gone for good', () => {
    // Regression: a second, drifted copy of the interface used to live inline
    // in the API tab.
    expect(existsSync(resolve(root, 'src/renderer/components/settings/SettingsSubAgents.tsx'))).toBe(false);
    const panel = read('src/renderer/components/SettingsPanel.tsx');
    expect(panel).not.toContain('SettingsSubAgents');
  });

  it('Settings exposes its own Sub-agents tab, hosting the shared view', () => {
    // Product requirement: the sub-agents interface must be reachable from
    // Settings, not only from the sidebar. It reuses the SAME component (one
    // implementation, two hosts) instead of reintroducing a copy.
    const panel = read('src/renderer/components/SettingsPanel.tsx');
    expect(panel).toContain("import { SubAgentsView } from './subagents/SubAgentsView'");
    expect(panel).toContain("id: 'subagents' as TabId");
    expect(panel).toContain("label: t('settings.subAgents')");
    expect(panel).toContain("labelKey: 'settings.groupModel', tabs: ['api', 'sandbox', 'subagents']");
    // The host supplies the close action; the sidebar host falls back to the
    // store flag.
    expect(panel).toContain('<SubAgentsView onClose={onClose} />');
    const view = read('src/renderer/components/subagents/SubAgentsView.tsx');
    expect(view).toContain('export function SubAgentsView({ onClose }');
    expect(view).toContain('if (onClose) onClose();');
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
    expect(view).toContain("import { ProposedSkillsSection } from '../settings/SettingsSkillDoctor'");
    expect(view).toContain('<ProposedSkillsSection />');
    const doctor = read('src/renderer/components/settings/SettingsSkillDoctor.tsx');
    expect(doctor).toContain('export function ProposedSkillsSection');
  });

  it('the dedicated view persists through the SAME config IPC as before', () => {
    const view = read('src/renderer/components/subagents/SubAgentsView.tsx');
    expect(view).toContain('window.electronAPI.config.get()');
    expect(view).toContain("subAgents: buildSubAgentsUpdate(draft)");
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
