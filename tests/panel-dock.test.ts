import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf-8');

describe('PanelDock — unified workspace dock replaces the floating pills', () => {
  const dock = read('src/renderer/components/PanelDock.tsx');
  const app = read('src/renderer/App.tsx');
  const chatView = read('src/renderer/components/ChatView.tsx');
  const welcomeView = read('src/renderer/components/WelcomeView.tsx');
  const panels = read('src/shared/workspace-panels.ts');
  const toggles = read('src/renderer/utils/workspace-panel-toggles.ts');

  it('renders every panel from one glass toolbar with tooltips and pressed state', () => {
    expect(dock).toContain('role="toolbar"');
    expect(dock).toContain('aria-label={tooltip}');
    expect(dock).toContain('aria-pressed={active}');
    expect(dock).toContain('title={tooltip}');
    expect(dock).toContain('panel-glass');
  });

  it('covers both full-page views and side inspectors', () => {
    for (const id of ['modelRouting', 'controlCenter', 'memory', 'plan'] as const) {
      expect(panels).toContain(`id: '${id}'`);
    }
    for (const id of ['delegatedTasks', 'document', 'diff'] as const) {
      expect(panels).toContain(`id: '${id}'`);
    }
    // The dock renders icons for every descriptor id.
    expect(dock).toContain('PANEL_ICONS');
  });

  it('mounts a single side inspector at a time', () => {
    expect(dock).toContain('setInspectorOpen');
    expect(toggles).toContain('setDelegatedTasksVisible');
    expect(toggles).toContain('setDocumentPanelVisible');
    expect(toggles).toContain('setDiffPanelVisible');
    expect(toggles).toContain('open && panelId === id');
    expect(toggles).toContain('WORKSPACE_INSPECTOR_PANEL_IDS');
  });

  it('closes sibling full-page views when opening one', () => {
    expect(toggles).toContain('setModelRoutingVisible');
    expect(toggles).toContain('toggleViewPanel');
    expect(toggles).toContain('WORKSPACE_VIEW_PANEL_IDS');
    // Dock buttons go through the shared entry point.
    expect(dock).toContain('toggleWorkspacePanel(panel.id)');
  });

  it('surfaces running delegated tasks as a badge and a clickable chip', () => {
    expect(dock).toContain('runningBackgroundTasks');
    expect(dock).toContain('sessionTasks.length');
    expect(dock).toContain("setInspectorOpen('delegatedTasks', true)");
    expect(dock).toContain('animate-spin');
  });

  it('hides session-scoped panels when no session is active', () => {
    expect(dock).toContain('!panel.requiresSession || Boolean(activeSessionId)');
    expect(panels).toContain('requiresSession: true');
    // The same gate protects the keyboard and the app menu.
    expect(toggles).toContain('panel.requiresSession && !state.activeSessionId');
  });

  it('binds ⌘/Ctrl+1..7 to the panels in fixed dock order', () => {
    expect(dock).toContain('String(candidate.shortcut) === event.key');
    expect(dock).toContain('event.metaKey || event.ctrlKey');
    // Key auto-repeat must not hammer the toggle while a combo is held.
    expect(dock).toContain('event.repeat');
    expect(dock).toContain("window.addEventListener('keydown', onKeyDown)");
    expect(dock).toContain("window.removeEventListener('keydown', onKeyDown)");
    // Platform-aware hint in the tooltip.
    expect(dock).toContain("t('panelDock.shortcut'");
  });

  // Regression: the ⌘/Ctrl hint used to be derived from `navigator.platform`,
  // which Apple has deprecated (it freezes to "MacIntel" on every device) and
  // which describes the browser rather than the running app. The dock now reads
  // the real platform from the preload, matching Titlebar, SandboxSetupDialog
  // and SettingsSandbox — it was the last component still sniffing the UA.
  it('derives the ⌘/Ctrl shortcut hint from the preload platform, not the user agent', () => {
    // Delegated to the shared helper rather than re-deriving the platform here.
    expect(dock).toContain("import { isMac } from '../utils/platform'");
    // Strip comments before asserting the absence of the sniffing APIs: the
    // doc block above isMacPlatform() names them precisely to explain why they
    // are no longer used.
    const code = dock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('navigator.platform');
    expect(code).not.toContain('navigator.userAgent');
    expect(code).not.toContain('electronAPI?.platform');
  });

  it('flashes the delegated-tasks badge green when a task completes', () => {
    const tailwind = read('tailwind.config.js');
    expect(tailwind).toContain("'badge-flash'");
    expect(tailwind).toContain('badgeFlash');
    expect(dock).toContain('animate-badge-flash');
    expect(dock).toContain('bg-success');
    // The badge stays on screen for the flash even when the count drops to 0…
    expect(dock).toContain('badge > 0 || flash');
    // …and shows a check instead of a zero.
    expect(dock).toContain('<Check');
    // …for exactly the animation duration, then settles.
    expect(dock).toContain('setCompletedFlash(false)');
  });

  it('is mounted above the composer in chat and above the welcome form', () => {
    expect(chatView).toContain('<PanelDock />');
    expect(welcomeView).toContain('<PanelDock />');
    expect(app).not.toContain('fixed bottom-4 right-');
    expect(app).not.toContain('fixed bottom-14 right-4');
    expect(app).not.toContain('fixed bottom-4 left-4');
  });

  it('renders side panels inside the layout flow instead of floating cards', () => {
    expect(app).toContain('diffPanelVisible && activeSessionId && (');
    expect(app).toContain('documentPanelVisible && (');
    expect(app).toContain('delegatedTasksVisible && (');
    for (const panel of ['DiffPanel', 'DocumentPanel', 'DelegatedTasksPanel'] as const) {
      expect(app).toContain(`name="${panel}"`);
    }
    // No panel container should float over the composer anymore.
    expect(app).not.toContain('shadow-xl');
  });

  it('slides side panels in with the real animation utility', () => {
    const tailwind = read('tailwind.config.js');
    expect(tailwind).toContain("'slide-in-right'");
    expect(tailwind).toContain('slideInRight');
    // The side panel containers use it.
    expect(app).toContain('animate-slide-in-right');
  });

  it('gives every side panel a close affordance in its header', () => {
    for (const file of [
      'src/renderer/components/DiffPanel.tsx',
      'src/renderer/components/DocumentPanel.tsx',
      'src/renderer/components/DelegatedTasksPanel.tsx',
    ] as const) {
      const source = read(file);
      expect(source).toContain('common.close');
    }
    expect(read('src/renderer/components/DiffPanel.tsx')).toContain('setDiffPanelVisible(false)');
  });

  it('ships dock and shortcut labels through i18n in all locales', () => {
    for (const locale of ['fr', 'en', 'zh'] as const) {
      const dict = read(`src/renderer/i18n/locales/${locale}.json`);
      expect(dict).toContain('"panelDock"');
      expect(dict).toContain('"shortcut"');
      expect(dict).toContain('"modelPicker"');
      expect(dict).toContain('"voiceStart"');
    }
  });
});
