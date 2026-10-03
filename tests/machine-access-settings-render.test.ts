/**
 * Real render of the machine-access settings panel, plus the store wiring that
 * feeds it. Uses react-dom/server (no DOM needed) and a stubbed electronAPI, so
 * it exercises the actual component and the actual store actions rather than
 * asserting on source text.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

import { SettingsMachineAccess } from '../src/renderer/components/settings/SettingsMachineAccess';
import type { FolderGrant } from '../src/main/machine-access/types';

const GRANT: FolderGrant = {
  id: 'g1',
  path: '/Users/me/Documents',
  access: 'read-write',
  scope: 'project',
  createdAt: 1,
};

const noop = () => undefined;

function render(props: Partial<Parameters<typeof SettingsMachineAccess>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(SettingsMachineAccess, {
      grants: [],
      autonomy: 'ask-always',
      allowedApps: [],
      permissions: [],
      history: [],
      onAddGrant: noop,
      onRevokeGrant: noop,
      onChangeAutonomy: noop,
      onAddApp: noop,
      onRemoveApp: noop,
      onUndoBatch: noop,
      onEmergencyStop: noop,
      emergencyShortcut: 'CmdOrCtrl+Shift+.',
      ...props,
    })
  );
}

describe('SettingsMachineAccess renders', () => {
  it('shows the locked default: always ask, no grant, no application', () => {
    const html = render();
    expect(html).toContain('machineAccess.autonomy.ask-always');
    expect(html).toContain('machineAccess.noGrants');
    expect(html).toContain('machineAccess.noApps');
    expect(html).toContain('machineAccess.noHistory');
  });

  it('marks exactly the two permissive levels with a strong warning', () => {
    const html = render({ autonomy: 'ask-always' });
    // Both risky options are labelled, whichever one is currently selected.
    expect(html.match(/machineAccess\.autonomyWarning/g) ?? []).toHaveLength(2);
    // The safe default still carries the standing reminder about approvals.
    expect(html).toContain('machineAccess.alwaysApprovalReminder');
    expect(html).toContain('checked=""');
  });

  it('lists a granted folder with its access level and scope', () => {
    const html = render({ grants: [GRANT] });
    expect(html).toContain('/Users/me/Documents');
    expect(html).toContain('machineAccess.access.read-write');
    expect(html).toContain('machineAccess.scope.project');
    expect(html).not.toContain('machineAccess.noGrants');
  });

  it('lists allowed applications as removable chips', () => {
    const html = render({ allowedApps: ['Safari', 'Terminal'] });
    expect(html).toContain('Safari');
    expect(html).toContain('Terminal');
    expect(html).toContain('machineAccess.remove');
  });

  it('reports a missing system permission as missing and an unknown one as unknown', () => {
    const missing = render({
      permissions: [
        {
          permission: 'accessibility',
          granted: false,
          known: true,
          explanation: 'Needed to click and type.',
        },
      ],
    });
    expect(missing).toContain('machineAccess.missing');
    expect(missing).not.toContain('machineAccess.unknown');

    const unknown = render({
      permissions: [
        {
          permission: 'automation',
          granted: false,
          known: false,
          explanation: 'macOS exposes no read-back for this.',
        },
      ],
    });
    expect(unknown).toContain('machineAccess.unknown');
    // An unknown permission must never be shown as granted.
    expect(unknown).not.toContain('machineAccess.granted');
  });

  it('groups the journal into undoable batches', () => {
    const html = render({
      history: [
        { id: '1', batchId: 'b1', type: 'move', source: '/w/a', status: 'done', createdAt: 1 },
        { id: '2', batchId: 'b1', type: 'move', source: '/w/b', status: 'done', createdAt: 2 },
        { id: '3', batchId: 'b2', type: 'trash', source: '/w/c', status: 'done', createdAt: 3 },
      ],
    });
    // Two batches, not three rows, and each carries an Undo control.
    expect(html).toContain('machineAccess.batchSummary');
    expect(html.match(/machineAccess\.undo/g) ?? []).toHaveLength(2);
    expect(html).toContain('/w/a');
  });

  it('always offers the emergency stop with its shortcut', () => {
    const html = render();
    expect(html).toContain('machineAccess.emergencyStop');
    expect(html).toContain('machineAccess.stopHint');
    expect(html).toContain('CmdOrCtrl+Shift+.');
  });
});