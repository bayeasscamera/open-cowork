import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import type { AppConfig } from '../src/renderer/types';

// Node-only suite: exercise the component function with state slots, like
// settings-web-search.test.ts, plus a no-op useEffect (no real mounting).
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = initial;
      return [
        hooks.slots[index],
        (next: unknown) => {
          hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
      return hooks.slots[index];
    },
    useEffect: () => {},
  };
});
const changeLanguage = vi.fn();
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage },
  }),
}));
vi.mock('../src/renderer/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/store')>();
  return {
    useAppStore: Object.assign(
      <T>(selector: (state: ReturnType<typeof actual.useAppStore.getState>) => T) =>
        selector(actual.useAppStore.getState()),
      actual.useAppStore
    ),
  };
});

import { useAppStore } from '../src/renderer/store';
import { SettingsGeneral } from '../src/renderer/components/settings/SettingsGeneral';
import { SettingsContentSection } from '../src/renderer/components/settings/shared';

interface ElementProps {
  children?: ReactNode;
  className?: string;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
  'aria-pressed'?: boolean;
}

function elements(node: ReactNode): Array<{ type: unknown; props: ElementProps }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children)];
}

function texts(node: ReactNode): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (isValidElement(node)) return texts(node.props.children);
  return [];
}

function render() {
  hooks.cursor = 0;
  const component = SettingsGeneral();
  const tree = elements(component);
  return {
    tree,
    tray: tree.find((node) => node.props.className?.includes('h-6 w-11'))?.props,
    buttons: tree.filter((node) => node.type === 'button'),
    sections: tree.filter((node) => node.type === SettingsContentSection),
    text: texts(component).join(' '),
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

const baseConfig: AppConfig = {
  provider: 'openai',
  apiKey: '',
  model: '',
  activeProfileKey: 'openai',
  profiles: {},
  configSets: [],
  activeConfigSetId: 'default',
  isConfigured: false,
};

const save = vi.fn();
const getVersion = vi.fn();
const configGet = vi.fn();

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  vi.clearAllMocks();
  useAppStore.setState({ appConfig: { ...baseConfig } });
  getVersion.mockResolvedValue('3.5.0');
  configGet.mockResolvedValue({ trayEnabled: false });
  save.mockResolvedValue({ success: true, config: baseConfig });
  vi.stubGlobal('window', {
    electronAPI: {
      platform: 'darwin',
      getVersion,
      config: { get: configGet, save },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('settings general overview', () => {
  it('toggles background access and persists it through config.save', async () => {
    let view = render();
    expect(view.tray?.['aria-pressed']).toBe(false);
    view.tray?.onClick?.();
    await flush();
    expect(save).toHaveBeenCalledWith({ trayEnabled: true });
    expect(render().tray?.['aria-pressed']).toBe(true);
    render().tray?.onClick?.();
    await flush();
    expect(save).toHaveBeenLastCalledWith({ trayEnabled: false });
  });

  it('shows a quick-access link for every major settings screen', () => {
    const setSettingsTab = vi.fn();
    useAppStore.setState({ setSettingsTab } as never);
    const view = render();
    const linkButtons = view.buttons.filter((node) =>
      node.props.className?.includes('justify-between')
    );
    expect(linkButtons.length).toBe(6);
    linkButtons[0].props.onClick?.();
    expect(setSettingsTab).toHaveBeenCalledWith('api');
    linkButtons[5].props.onClick?.();
    expect(setSettingsTab).toHaveBeenCalledWith('logs');
  });

  it('summarizes the active config set with provider and model', () => {
    useAppStore.setState({
      appConfig: {
        ...baseConfig,
        provider: 'custom',
        isConfigured: true,
        activeConfigSetId: 'set-1',
        configSets: [
          {
            id: 'set-1',
            name: 'Main',
            provider: 'openai',
            customProtocol: 'openai',
            activeProfileKey: 'openai',
            profiles: { openai: { apiKey: '', model: 'gpt-overview' } },
            enableThinking: false,
            updatedAt: new Date().toISOString(),
          },
        ],
      } as AppConfig,
    });
    const view = render();
    expect(view.text).toContain('OpenAI');
    expect(view.text).toContain('gpt-overview');
    expect(view.text).toContain('general.configReady');
  });

  it('falls back to a not-configured badge and shows system rows', () => {
    const view = render();
    expect(view.text).toContain('general.configMissing');
    expect(view.text).toContain('general.systemVersion');
    expect(view.text).toContain('darwin');
    expect(
      view.sections.some((section) => section.props.title === 'general.systemSection')
    ).toBe(true);
  });

  it('applies the selected theme through updateSettings', () => {
    const updateSettings = vi.fn();
    useAppStore.setState({ updateSettings } as never);
    const view = render();
    const darkButton = view.buttons.find((node) => node.props.children === 'general.themeDark');
    darkButton?.props.onClick?.();
    expect(updateSettings).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('switches the interface language through i18n', () => {
    const view = render();
    const frenchButton = view.buttons.find((node) => node.props.children === 'Français');
    frenchButton?.props.onClick?.();
    expect(changeLanguage).toHaveBeenCalledWith('fr');
  });
});