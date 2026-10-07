import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';

// Node-only suite: call the component function with state slots, like
// settings-general-overview.test.ts, plus a no-op useEffect (no real mounting).
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));

// `SettingsSandbox` derives `isElectron` once, at module scope, so the context
// bridge has to exist *before* the module is imported. `vi.hoisted` runs ahead
// of the import statements below; `beforeEach` then installs fresh mocks.
vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = { electronAPI: {} };
});

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
    useEffect: () => {},
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { SettingsSandbox } from '../src/renderer/components/settings/SettingsSandbox';

interface ElementProps {
  children?: ReactNode;
  className?: string;
  role?: string;
  disabled?: boolean;
  onClick?: () => void;
  'aria-checked'?: boolean;
}

function elements(node: ReactNode): Array<{ type: unknown; props: ElementProps }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children)];
}

function render() {
  hooks.cursor = 0;
  const tree = elements(SettingsSandbox());
  return { tree, toggle: tree.find((node) => node.props.role === 'switch')?.props };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const save = vi.fn();
const configGet = vi.fn();
const getStatus = vi.fn();

const wslReady = {
  platform: 'win32',
  mode: 'wsl',
  initialized: true,
  wsl: { available: true, nodeAvailable: true },
};

beforeEach(() => {
  hooks.cursor = 0;
  // The component shows a spinner until its init effect resolves. That effect is
  // a no-op here, so seed the slots with the post-init state instead. Order is
  // the component's own: [sandboxEnabled, status, isLoading, isChecking,
  // isInstalling, error, success, isInitialized, isToggling].
  hooks.slots = [true, wslReady, false, false, null, null, null, true, false];

  vi.clearAllMocks();
  vi.useFakeTimers();
  configGet.mockResolvedValue({ sandboxEnabled: true });
  getStatus.mockResolvedValue(wslReady);
  save.mockResolvedValue({ success: true, config: {} });

  vi.stubGlobal('window', {
    electronAPI: {
      platform: 'win32',
      arch: 'x64',
      config: { get: configGet, save },
      sandbox: { getStatus },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('settings sandbox toggle', () => {
  it('persists sandboxEnabled through config.save and reflects the new value', async () => {
    const view = render();
    expect(view.toggle?.['aria-checked']).toBe(true);

    view.toggle?.onClick?.();
    await flush();
    expect(save).toHaveBeenCalledWith({ sandboxEnabled: false });
    expect(render().toggle?.['aria-checked']).toBe(false);

    render().toggle?.onClick?.();
    await flush();
    expect(save).toHaveBeenLastCalledWith({ sandboxEnabled: true });
    expect(render().toggle?.['aria-checked']).toBe(true);
  });

  it('keeps the previous value when the save fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    save.mockRejectedValueOnce(new Error('disk full'));

    const view = render();
    expect(view.toggle?.['aria-checked']).toBe(true);

    view.toggle?.onClick?.();
    await flush();

    expect(save).toHaveBeenCalledWith({ sandboxEnabled: false });
    expect(render().toggle?.['aria-checked']).toBe(true);
    consoleError.mockRestore();
  });
});
