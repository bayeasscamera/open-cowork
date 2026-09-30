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

  it('renders every panel from one glass toolbar with tooltips and pressed state', () => {
    expect(dock).toContain('role="toolbar"');
    expect(dock).toContain('aria-label={tooltip}');
    expect(dock).toContain('aria-pressed={active}');
    expect(dock).toContain('title={tooltip}');
    expect(dock).toContain('panel-glass');
  });

  it('covers both full-page views and side inspectors', () => {
    for (const id of ['modelRouting', 'controlCenter', 'memory', 'plan'] as const) {
      expect(dock).toContain(`'${id}'`);
    }
    for (const id of ['delegatedTasks', 'document', 'diff'] as const) {
      expect(dock).toContain(`'${id}'`);
    }
  });

  it('mounts a single side inspector at a time', () => {
    expect(dock).toContain('setInspectorOpen');
    expect(dock).toContain("state.setDelegatedTasksVisible(open && id === 'delegatedTasks')");
    expect(dock).toContain("state.setDocumentPanelVisible(open && id === 'document')");
    expect(dock).toContain("state.setDiffPanelVisible(open && id === 'diff')");
  });

  it('closes sibling full-page views when opening one', () => {
    expect(dock).toContain("state.setModelRoutingVisible(open && id === 'modelRouting')");
    expect(dock).toContain('toggleViewPanel');
  });

  it('surfaces running delegated tasks as a badge and a clickable chip', () => {
    expect(dock).toContain('runningBackgroundTasks');
    expect(dock).toContain('sessionTasks.length');
    expect(dock).toContain("setInspectorOpen('delegatedTasks', true)");
    expect(dock).toContain('animate-spin');
  });

  it('hides session-scoped panels when no session is active', () => {
    expect(dock).toContain('!item.requiresSession || Boolean(activeSessionId)');
    expect(dock).toContain('SESSION_SCOPED');
  });

  it('binds ⌘/Ctrl+1..7 to the panels in fixed dock order', () => {
    expect(dock).toContain('SHORTCUT_KEYS');
    expect(dock).toContain("['1', '2', '3', '4', '5', '6', '7']");
    expect(dock).toContain('event.metaKey || event.ctrlKey');
    expect(dock).toContain("window.addEventListener('keydown', onKeyDown)");
    expect(dock).toContain("window.removeEventListener('keydown', onKeyDown)");
    // Platform-aware hint in the tooltip.
    expect(dock).toContain("t('panelDock.shortcut'");
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
