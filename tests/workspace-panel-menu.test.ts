import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf-8');

/**
 * Discoverability: the macOS application menu lists every workspace panel
 * with its ⌘/Ctrl+<n> shortcut. The menu lives in the main process, so it is
 * driven by the same `WORKSPACE_PANELS` descriptors as the dock and toggles
 * through the shared renderer entry point via the `panel.toggle` event.
 */
describe('app menu "Panels" lists the workspace shortcuts', () => {
  const main = read('src/main/index.ts');
  const panels = read('src/shared/workspace-panels.ts');
  const types = read('src/shared/types.ts');
  const useIpc = read('src/renderer/hooks/useIPC.ts');
  const toggles = read('src/renderer/utils/workspace-panel-toggles.ts');
  const dock = read('src/renderer/components/PanelDock.tsx');

  it('builds the menu from the shared panel descriptors', () => {
    expect(main).toContain("labels?.panels ?? 'Panels'");
    expect(main).toContain('WORKSPACE_PANELS.filter');
    expect(main).toContain('panelMenuItem');
    // The shortcut is registered as a real accelerator, so the menu both
    // displays AND triggers it.
    expect(main).toContain('accelerator: `CmdOrCtrl+${panel.shortcut}`');
  });

  it('toggles the clicked panel through the server event', () => {
    expect(main).toContain("sendToRenderer({ type: 'panel.toggle', payload: panel.id })");
    expect(types).toContain("type: 'panel.toggle'");
    expect(types).toContain('WorkspacePanelId');
    expect(useIpc).toContain("case 'panel.toggle'");
    expect(useIpc).toContain('toggleWorkspacePanel(event.payload)');
  });

  it('keeps a fixed 1..7 shortcut order with a label for every panel', () => {
    const shortcuts = [...panels.matchAll(/shortcut: (\d+)/g)].map((match) => Number(match[1]));
    expect(shortcuts).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const menuLabels = [...panels.matchAll(/menuLabel: '([^']+)'/g)].map((match) => match[1]);
    expect(menuLabels).toHaveLength(7);
    for (const label of menuLabels) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('routes menu, keyboard and dock through the same shared toggle', () => {
    expect(dock).toContain('toggleWorkspacePanel(panel.id)');
    expect(toggles).toContain('export function toggleWorkspacePanel');
    // Session gating is enforced in one place for every entry point.
    expect(toggles).toContain('panel.requiresSession && !state.activeSessionId');
  });
});
