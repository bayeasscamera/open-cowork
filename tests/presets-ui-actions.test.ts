import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * UI action contracts for the agent presets surface.
 *
 * Same style as projects-ui-polish.test.ts: source-level assertions, because the
 * behaviours that matter here are (a) the panel really calls the main process
 * rather than mutating anything itself, and (b) approval consent is per
 * proposal rather than a sticky global checkbox. Both are easy to break with
 * a refactor that still compiles and still looks right.
 */

const panel = readFileSync(
  'src/renderer/components/settings/SettingsPresets.tsx',
  'utf8'
);
const projects = readFileSync(
  'src/renderer/components/projects/ProjectsPages.tsx',
  'utf8'
);
const settingsPanel = readFileSync('src/renderer/components/SettingsPanel.tsx', 'utf8');
const handler = readFileSync('src/main/ipc/preset-handlers.ts', 'utf8');
const preload = readFileSync('src/preload/index.ts', 'utf8');
const localesDir = path.resolve(process.cwd(), 'src/renderer/i18n/locales');

type Dict = Record<string, string | Dict>;

function loadLocale(name: string): Dict {
  return JSON.parse(readFileSync(path.join(localesDir, `${name}.json`), 'utf8'));
}

function flatten(dict: Dict, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dict)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[fullKey] = value;
    else Object.assign(out, flatten(value, fullKey));
  }
  return out;
}

describe('Settings → Presets is reachable and reads through the main process', () => {
  it('is registered as a settings tab in the Model group', () => {
    expect(settingsPanel).toContain("id: 'presets' as TabId");
    expect(settingsPanel).toContain("label: t('settings.presets')");
    expect(settingsPanel).toContain('<SettingsPresets');
    const modelGroup = /labelKey: 'settings\.groupModel', tabs: \[([^\]]*)\]/.exec(settingsPanel);
    expect(modelGroup?.[1]).toContain("'presets'");
  });

  it('loads and acts only through the presets IPC surface', () => {
    expect(panel).toContain('window.electronAPI.presets.overview()');
    expect(panel).toContain('window.electronAPI.presets.approve(');
    expect(panel).toContain('window.electronAPI.presets.reject(');
    // The renderer must not write preset files itself.
    expect(panel).not.toMatch(/writeFile|fs\./);
  });

  it('exposes the three presets channels in the preload bridge', () => {
    expect(preload).toContain("ipcRenderer.invoke('presets.overview')");
    expect(preload).toContain("ipcRenderer.invoke('presets.approve'");
    expect(preload).toContain("ipcRenderer.invoke('presets.reject'");
  });

  it('registers the handlers in the main process', () => {
    expect(handler).toContain("IPCRouter.handle('presets.overview'");
    expect(handler).toContain("IPCRouter.handle(\n    'presets.approve'");
    expect(handler).toContain("IPCRouter.handle(\n    'presets.reject'");
  });
});

describe('consent is per proposal, never a sticky global checkbox', () => {
  it('keys consent by proposal id', () => {
    expect(panel).toContain('Record<string, boolean>');
    expect(panel).toContain('consented[proposal.id] === true');
    expect(panel).toMatch(/setConsented\(\(previous\) => \(\{ \.\.\.previous,/);
  });

  it('renders the consent checkbox only for a proposal that needs it', () => {
    expect(panel).toContain('proposal.requiresConsent &&');
    expect(panel).toContain("data-testid={`preset-consent-${proposal.id}`}");
  });

  it('shows the concrete consent reasons, not a generic warning', () => {
    expect(panel).toContain('proposal.consentReasons.map');
  });

  it('the handler forwards consent and fails closed when it is absent', () => {
    expect(handler).toContain('payload?.consent === true');
  });
});

describe('capability-changing presets carry a visible warning', () => {
  it('warns when a preset uses code mode', () => {
    expect(panel).toContain('preset.presentation === \'code\'');
    expect(panel).toContain("t('presets.codeModeWarning')");
  });

  it('warns when a preset uses a very large context budget', () => {
    expect(panel).toContain('preset.pruner.thresholdChars >= 384000');
    expect(panel).toContain("t('presets.longContextWarning')");
  });
});

describe('a project pins a preset, with the default as the empty value', () => {
  it('renders a selector that persists through the update IPC', () => {
    expect(projects).toContain('data-testid="project-preset-select"');
    expect(projects).toContain('window.electronAPI.projects.update({');
    expect(projects).toContain('presetId: presetId === \'\' ? null : presetId');
  });

  it('re-reads the project after a successful pin instead of patching state', () => {
    // Patching local state would drift from what the main process persisted.
    expect(projects).toMatch(/if \(result\.success\) \{[\s\S]{0,200}await refresh\(\);/);
  });

  it('surfaces a failed pin rather than leaving a false success', () => {
    expect(projects).toContain("setError(result.error || t('projects.errors.updateFailed')");
  });
});

describe('every new user-facing string exists in all three locales', () => {
  const en = flatten(loadLocale('en'));

  it('the presets block is present and complete in en, fr and zh', () => {
    const presetKeys = Object.keys(en).filter((key) => key.startsWith('presets.'));
    expect(presetKeys.length).toBeGreaterThan(20);
    for (const locale of ['fr', 'zh']) {
      const keys = flatten(loadLocale(locale));
      for (const key of presetKeys) {
        expect(keys[key], `${locale} is missing ${key}`).toBeTruthy();
      }
    }
  });

  it('the settings tab label and the project selector label are translated', () => {
    for (const key of [
      'settings.presets',
      'settings.presetsDesc',
      'projects.presetLabel',
      'projects.presetDefault',
      'projects.errors.updateFailed',
    ]) {
      expect(en[key], `en is missing ${key}`).toBeTruthy();
      for (const locale of ['fr', 'zh']) {
        expect(flatten(loadLocale(locale))[key], `${locale} is missing ${key}`).toBeTruthy();
      }
    }
  });
});
