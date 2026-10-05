import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModsV2Section } from '../src/renderer/components/settings/ModsV2Section';
import type { ContributedUiDto } from '../src/shared/mods-v2-contract';
import type { ModUiContribution } from '@cowork/mod-api';

/**
 * The declarative-UI chain ends here: a contribution that reached main must be
 * drawable in the mods panel. These tests pin the last link — the settingsTab
 * slot is rendered through ModDeclarativeUi with the mod id attached, and
 * contributions for slots without host chrome (statusBar, sidePanel, …) are
 * NOT drawn.
 *
 * The section uses hooks, so it is RENDERED through createElement — vitest only
 * collects `.test.ts`, hence no JSX.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { reason?: string }) => (opts?.reason ? `${key}:${opts.reason}` : key),
  }),
}));

function render(props: Parameters<typeof ModsV2Section>[0]): string {
  return renderToStaticMarkup(createElement(ModsV2Section, props));
}

const contribution = (slot: ModUiContribution['slot'], label: string): ContributedUiDto => ({
  modId: 'mod-a',
  contribution: { slot, nodes: [{ kind: 'text', label }] },
});

describe('mods panel declarative UI', () => {
  it('renders a settingsTab contribution with the mod id attached', () => {
    const html = render({
      initialMods: [],
      initialUiContributions: [contribution('settingsTab', 'mod says hello')],
    });
    expect(html).toContain('mods.v2.uiContributions');
    expect(html).toContain('mod says hello');
    expect(html).toContain('data-mod-id="mod-a"');
    expect(html).toContain('data-mod-slot="settingsTab"');
  });

  it('does not draw slots that have no host chrome', () => {
    const html = render({
      initialMods: [],
      initialUiContributions: [
        contribution('statusBar', 'status text'),
        contribution('sidePanel', 'side text'),
        contribution('messageActions', 'action text'),
      ],
    });
    expect(html).not.toContain('status text');
    expect(html).not.toContain('side text');
    expect(html).not.toContain('action text');
    expect(html).not.toContain('mods.v2.uiContributions');
  });

  it('renders nothing extra when no mod contributes UI', () => {
    const html = render({ initialMods: [], initialUiContributions: [] });
    expect(html).not.toContain('data-mods-v2-ui');
  });

  it('seeds nothing when contributions arrive only via the subscription', () => {
    // No seed: the panel must not fabricate contributions. (Effects do not run
    // under renderToStaticMarkup, so the live fetch/subscribe is not exercised
    // here — that path is covered by the host tests and the wiring in
    // SettingsMods.)
    const html = render({ initialMods: [] });
    expect(html).not.toContain('mods.v2.uiContributions');
  });
});
