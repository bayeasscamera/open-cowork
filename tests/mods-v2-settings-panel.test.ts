import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModsV2Section } from '../src/renderer/components/settings/ModsV2Section';
import type { InstalledModDto, SafeModeDto } from '../src/shared/mods-v2-contract';

/**
 * The mods panel is the last thing between a user and unreviewed code running in
 * the main process, so these tests pin the three things it must never do: hide
 * the access warning, hide the pinned fingerprint, or present a declaration as
 * if it were a limit.
 *
 * The panel uses hooks, so it is RENDERED through `createElement` rather than
 * called as a function — vitest only collects `.test.ts`, hence no JSX.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { reason?: string }) => (opts?.reason ? `${key}:${opts.reason}` : key),
  }),
}));

function render(props: Parameters<typeof ModsV2Section>[0]): string {
  return renderToStaticMarkup(createElement(ModsV2Section, props));
}

function mod(overrides: Partial<InstalledModDto> = {}): InstalledModDto {
  return {
    id: 'demo-mod',
    version: '1.0.0',
    band: 'user',
    source: 'local folder',
    installedAt: 1,
    fingerprint: 'a'.repeat(64),
    enabled: true,
    ...overrides,
  };
}

function safe(overrides: Partial<SafeModeDto> = {}): SafeModeDto {
  return { active: false, reason: 'none', crashedMods: [], consecutiveBootFailures: 0, ...overrides };
}

describe('mods panel', () => {
  it('always states that a mod has the same access as Cowork', () => {
    const html = render({ initialMods: [], initialSafeMode: safe() });
    // Present even with no mod installed: the warning is the reason to read this
    // panel before installing anything, so it must not be conditional.
    expect(html).toContain('mods-v2__warning');
    expect(html).toContain('role="note"');
  });

  it('shows the pinned fingerprint next to each mod', () => {
    const html = render({ initialMods: [mod()], initialSafeMode: safe() });
    // The hash is the only control that actually binds: it is what the user
    // compares before and after an update.
    expect(html).toContain('aaaaaaaaaaaa');
  });

  it('labels a declaration as a declaration, never as a limit', () => {
    const html = render({
      initialMods: [mod({ declaredCapabilities: { fs: { read: [] }, storage: true } })],
      initialSafeMode: safe(),
    });
    expect(html).toContain('fs');
    expect(html).toContain('storage');
    // No network/model declared: the gap is the information, so it must not be
    // rendered as a reassuring dash.
    expect(html).not.toContain('network');
  });

  it('shows a dash when nothing is declared', () => {
    const html = render({ initialMods: [mod()], initialSafeMode: safe() });
    expect(html).toContain('—');
  });

  it('explains an automatic safe-mode entry rather than silently behaving', () => {
    const html = render({
      initialMods: [],
      initialSafeMode: safe({ active: true, reason: 'auto', crashedMods: ['demo-mod'] }),
    });
    expect(html).toContain('mods-v2__safe-mode');
    expect(html).toContain('role="status"');
    expect(html).toContain('reasonAuto');
  });

  it('reports a mod disabled by repeated failures with its last error', () => {
    const html = render({
      initialMods: [mod({ health: { disabled: true, failures: 3, lastError: 'hook timed out' } })],
      initialSafeMode: safe(),
    });
    expect(html).toContain('hook timed out');
  });

  it('offers enable/disable and uninstall per mod', () => {
    const html = render({ initialMods: [mod()], initialSafeMode: safe() });
    expect(html).toContain('data-mod-id="demo-mod"');
    expect(html).toContain('danger');
  });

  it('renders with no props at all rather than throwing', () => {
    const html = render({});
    expect(html).toContain('mods-v2');
  });
});