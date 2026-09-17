import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../src/renderer/types';
import en from '../src/renderer/i18n/locales/en.json';
import fr from '../src/renderer/i18n/locales/fr.json';
import zh from '../src/renderer/i18n/locales/zh.json';

// The existing suite runs in Node without a DOM renderer. Exercise the actual
// component handlers with state/ref slots, without adding test dependencies.
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
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
import { SettingsWebSearch } from '../src/renderer/components/settings/SettingsWebSearch';

interface ElementProps {
  children?: ReactNode;
  id?: string;
  type?: string;
  role?: string;
  value?: string;
  disabled?: boolean;
  htmlFor?: string;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  onClick?: () => void;
}
function elements(node: ReactNode): Array<{ type: unknown; props: ElementProps }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children)];
}
function render() {
  hooks.cursor = 0;
  const tree = elements(SettingsWebSearch());
  return {
    tree,
    input: (key: string) => tree.find((node) => node.props.id === `web-search-${key}`)?.props,
    save: tree.find((node) => node.type === 'button' && !node.props['aria-label'])?.props,
    toggles: tree.filter((node) => node.type === 'button' && node.props['aria-label']),
  };
}
const config: AppConfig = {
  provider: 'openai',
  apiKey: '',
  model: '',
  activeProfileKey: 'openai',
  profiles: {},
  configSets: [],
  activeConfigSetId: 'default',
  isConfigured: false,
  tavilyApiKey: 'saved-tavily',
  braveApiKey: 'saved-brave',
};
const save = vi.fn();

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  useAppStore.setState({ appConfig: { ...config }, isConfigured: false });
  vi.stubGlobal('window', { electronAPI: { config: { save } } });
});
afterEach(() => vi.unstubAllGlobals());

async function clickSave() {
  render().save?.onClick?.();
  await Promise.resolve();
  await Promise.resolve();
}

describe('web search settings', () => {
  it('loads saved keys masked, with labels and independent visibility controls', () => {
    let view = render();
    expect(view.input('tavilyApiKey')?.value).toBe('saved-tavily');
    expect(view.input('braveApiKey')?.type).toBe('password');
    for (const field of ['tavilyApiKey', 'braveApiKey']) {
      expect(view.input(field)?.type).toBe('password');
      expect(view.tree.some((node) => node.props.htmlFor === `web-search-${field}`)).toBe(true);
    }
    view.toggles[0].props.onClick?.();
    view = render();
    expect(view.input('tavilyApiKey')?.type).toBe('text');
    expect(view.input('braveApiKey')?.type).toBe('password');
    expect(view.toggles[0].props['aria-pressed']).toBe(true);
    view.toggles[0].props.onClick?.();
    expect(render().input('tavilyApiKey')?.type).toBe('password');
  });

  it('saves only trimmed search keys, supports clearing, and applies returned config', async () => {
    const returned = {
      ...config,
      tavilyApiKey: 'canonical',
      braveApiKey: '',
      model: 'returned-model',
      isConfigured: true,
    };
    save.mockResolvedValue({ success: true, config: returned });
    render()
      .input('tavilyApiKey')
      ?.onChange?.({ target: { value: '  new-tavily  ' } });
    render()
      .input('braveApiKey')
      ?.onChange?.({ target: { value: '  ' } });
    await clickSave();
    expect(save).toHaveBeenCalledWith({ tavilyApiKey: 'new-tavily', braveApiKey: '' });
    expect(useAppStore.getState().appConfig).toBe(returned);
    expect(useAppStore.getState().isConfigured).toBe(true);
    expect(render().input('tavilyApiKey')?.value).toBe('canonical');
    expect(render().tree.some((node) => node.props.role === 'status')).toBe(true);
  });

  it.each(['unsuccessful', 'missing config', 'rejection'])(
    'keeps edits and store unchanged on %s',
    async (failure) => {
      const before = useAppStore.getState().appConfig;
      if (failure === 'rejection') save.mockRejectedValue(new Error('sensitive-key'));
      else
        save.mockResolvedValue(
          failure === 'unsuccessful'
            ? { success: false, config: { ...config, tavilyApiKey: 'wrong' } }
            : { success: true }
        );
      render()
        .input('tavilyApiKey')
        ?.onChange?.({ target: { value: 'edited-key' } });
      await clickSave();
      expect(useAppStore.getState().appConfig).toBe(before);
      expect(render().input('tavilyApiKey')?.value).toBe('edited-key');
      expect(render().save?.disabled).toBe(false);
      const alert = render().tree.find((node) => node.props.role === 'alert');
      expect(alert?.props.children).toBe('api.webSearch.saveFailed');
      expect(render().tree.some((node) => node.props.role === 'status')).toBe(false);
      save.mockResolvedValue({ success: true, config });
      await clickSave();
      expect(render().tree.some((node) => node.props.role === 'alert')).toBe(false);
    }
  );

  it('blocks duplicate submissions and edits while saving', async () => {
    let finish: (value: { success: boolean; config: AppConfig }) => void = () => {};
    save.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const button = render().save;
    button?.onClick?.();
    button?.onClick?.();
    expect(save).toHaveBeenCalledTimes(1);
    expect(render().save?.disabled).toBe(true);
    expect(render().input('braveApiKey')?.disabled).toBe(true);
    finish({ success: true, config });
    await Promise.resolve();
    expect(render().save?.disabled).toBe(false);
  });

  it('waits for loaded config and preserves drafts across unrelated store updates', () => {
    useAppStore.setState({ appConfig: null });
    expect(render().save?.disabled).toBe(true);
    useAppStore.setState({ appConfig: config });
    expect(render().input('tavilyApiKey')?.value).toBe('saved-tavily');
    render()
      .input('tavilyApiKey')
      ?.onChange?.({ target: { value: 'draft' } });
    useAppStore.setState({
      appConfig: { ...config, model: 'changed', braveApiKey: 'updated-brave' },
    });
    expect(render().input('tavilyApiKey')?.value).toBe('draft');
    expect(render().input('braveApiKey')?.value).toBe('updated-brave');
  });

  it('is included in SettingsAPI and has matching nonempty en/fr/zh translations', () => {
    const source = readFileSync(
      new URL('../src/renderer/components/settings/SettingsAPI.tsx', import.meta.url),
      'utf8'
    );
    expect(source).toContain('<SettingsWebSearch />');
    for (const locale of [en, fr, zh]) {
      expect(Object.keys(locale.api.webSearch)).toEqual(Object.keys(en.api.webSearch));
      expect(Object.values(locale.api.webSearch).every((value) => value.trim())).toBe(true);
      expect(locale.api.webSearch.description).toContain('Tavily > Brave > DuckDuckGo');
    }
  });
});
