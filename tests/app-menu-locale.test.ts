import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAppMenuLabels } from '../src/renderer/utils/app-menu-labels';
import { buildDelegationOutcomeNotice } from '../src/renderer/utils/delegation-notices';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf-8');

describe('buildAppMenuLabels', () => {
  it('resolves every menu string and panel name through the catalogue', () => {
    const asked: string[] = [];
    const labels = buildAppMenuLabels((key) => {
      asked.push(key);
      return `t(${key})`;
    });
    expect(labels.preferences).toBe('t(appMenu.preferences)');
    expect(labels.edit).toBe('t(appMenu.edit)');
    expect(labels.view).toBe('t(appMenu.view)');
    expect(labels.panels).toBe('t(appMenu.panels)');
    expect(labels.window).toBe('t(appMenu.window)');
    expect(labels.newSession).toBe('t(appMenu.newSession)');
    expect(labels.settings).toBe('t(appMenu.settings)');
    // Panel names come from the fuller menu label keys, one per descriptor.
    expect(labels.panelNames.modelRouting).toBe('t(modelRouting.title)');
    expect(labels.panelNames.memory).toBe('t(memory.title)');
    expect(labels.panelNames.diff).toBe('t(diffPanel.title)');
    expect(Object.keys(labels.panelNames)).toHaveLength(7);
    expect(asked).toContain('appMenu.panels');
  });
});

describe('buildDelegationOutcomeNotice', () => {
  const t = (key: string, values?: Record<string, string | number>): string =>
    values ? `${key}:${String(values.title)}` : key;

  it('builds a success toast carrying the task title', () => {
    const notice = buildDelegationOutcomeNotice(t, 'Rapport', 'completed');
    expect(notice.type).toBe('success');
    expect(notice.messageKey).toBe('delegatedTasks.toastCompleted');
    expect(notice.messageValues).toEqual({ title: 'Rapport' });
    expect(notice.message).toBe('delegatedTasks.toastCompleted:Rapport');
    expect(notice.id).toContain('completed');
  });

  it('builds an error toast for failures', () => {
    const notice = buildDelegationOutcomeNotice(t, 'Rapport', 'failed');
    expect(notice.type).toBe('error');
    expect(notice.messageKey).toBe('delegatedTasks.toastFailed');
    expect(notice.id).toContain('failed');
  });
});

describe('localized app menu wiring', () => {
  const main = read('src/main/index.ts');
  const types = read('src/shared/types.ts');
  const preload = read('src/preload/index.ts');
  const handler = read('src/main/ipc/client-event-handler.ts');
  const sync = read('src/renderer/utils/app-menu-sync.ts');
  const app = read('src/renderer/App.tsx');
  const useIpc = read('src/renderer/hooks/useIPC.ts');
  const notices = read('src/renderer/utils/delegation-notices.ts');

  it('pushes the labels over a whitelisted client event', () => {
    expect(types).toContain('interface AppMenuLabels');
    expect(types).toContain('interface AppMenuState');
    expect(types).toContain("type: 'appMenu.sync'");
    expect(preload).toContain("'appMenu.sync': true");
    expect(sync).toContain("type: 'appMenu.sync'");
    expect(app).toContain('startAppMenuSync');
  });

  it('rebuilds the menu when the language or the active session changes', () => {
    expect(sync).toContain("i18n.on('languageChanged'");
    expect(sync).toContain('state.activeSessionId !== previous.activeSessionId');
    expect(handler).toContain("case 'appMenu.sync'");
    expect(handler).toContain('context.applyAppMenuState');
    expect(main).toContain('applyAppMenuState: (state)');
  });

  it('uses the localized labels with English fallbacks', () => {
    expect(main).toContain("labels?.preferences ?? 'Preferences…'");
    expect(main).toContain("labels?.panels ?? 'Panels'");
    expect(main).toContain("labels?.window ?? 'Window'");
    expect(main).toContain("appMenuState?.labels.panelNames[panel.id] ?? panel.menuLabel");
  });

  it('disables session-scoped menu entries until a session is active', () => {
    expect(main).toContain(
      'enabled: !panel.requiresSession || Boolean(appMenuState?.hasActiveSession)'
    );
  });

  it('ships every menu and toast string in all locales', () => {
    for (const locale of ['fr', 'en', 'zh'] as const) {
      const dict = read(`src/renderer/i18n/locales/${locale}.json`);
      expect(dict).toContain('"appMenu"');
      expect(dict).toContain('"toastCompleted"');
      expect(dict).toContain('"toastFailed"');
    }
  });

  it('toasts task outcomes behind the delegation notification gate', () => {
    expect(notices).toContain('notifyOnCompletion');
    expect(notices).toContain('backgroundTasks.getSettings');
    expect(useIpc).toContain('toastDelegationOutcome');
    expect(useIpc).toContain("status === 'completed' || status === 'failed'");
    expect(useIpc).toContain('delegationToastEnabled');
    // Cancellations never toast.
    expect(useIpc).not.toContain("status === 'cancelled'");
  });
});
