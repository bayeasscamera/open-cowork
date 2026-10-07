import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  safeOpenExternal: vi.fn(),
  revealFileInFolder: vi.fn(),
  showOpenDialog: vi.fn(),
  window: {
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handles.set(channel, fn);
    },
    on: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.listeners.set(channel, fn);
    },
  },
  app: { getVersion: () => '3.5.0' },
  nativeTheme: { shouldUseDarkColors: false },
  dialog: { showOpenDialog: mocks.showOpenDialog },
}));
vi.mock('../src/main/utils/safe-open-external', () => ({
  safeOpenExternal: mocks.safeOpenExternal,
}));
vi.mock('../src/main/utils/reveal-in-folder', () => ({
  revealFileInFolder: mocks.revealFileInFolder,
}));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { registerWindowIpcHandlers } from '../src/main/ipc/window-handlers';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = mocks.handles.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

describe('window IPC handlers', () => {
  beforeEach(() => {
    mocks.handles.clear();
    mocks.listeners.clear();
    vi.clearAllMocks();
  });

  it('registers every window, shell and system channel', () => {
    registerWindowIpcHandlers({ getMainWindow: () => null });
    expect([...mocks.handles.keys()].sort()).toEqual([
      'dialog.selectFiles',
      'get-version',
      'shell.openExternal',
      'shell.showItemInFolder',
      'system.getTheme',
    ]);
    expect([...mocks.listeners.keys()].sort()).toEqual([
      'window.close',
      'window.maximize',
      'window.minimize',
    ]);
  });

  it('routes external links and reveals through the hardened helpers', async () => {
    registerWindowIpcHandlers({ getMainWindow: () => null });
    await invoke('shell.openExternal', 'https://example.com');
    expect(mocks.safeOpenExternal).toHaveBeenCalledWith('https://example.com');

    mocks.revealFileInFolder.mockReturnValue({ success: true });
    expect(await invoke('shell.showItemInFolder', '/tmp/a.txt', '/tmp')).toEqual({ success: true });
    expect(mocks.revealFileInFolder).toHaveBeenCalledWith('/tmp/a.txt', '/tmp');
  });

  it('dialog.selectFiles returns the picked paths or an empty list on cancel', async () => {
    registerWindowIpcHandlers({ getMainWindow: () => null });
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/a', '/b'] });
    expect(await invoke('dialog.selectFiles')).toEqual(['/a', '/b']);

    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke('dialog.selectFiles')).toEqual([]);
  });

  it('window controls act on the injected window and ignore a destroyed one', () => {
    registerWindowIpcHandlers({ getMainWindow: () => mocks.window as never });
    mocks.window.isMaximized.mockReturnValue(true);

    mocks.listeners.get('window.minimize')?.({});
    mocks.listeners.get('window.maximize')?.({});
    mocks.listeners.get('window.close')?.({});

    expect(mocks.window.minimize).toHaveBeenCalledTimes(1);
    expect(mocks.window.unmaximize).toHaveBeenCalledTimes(1);
    expect(mocks.window.maximize).not.toHaveBeenCalled();
    expect(mocks.window.close).toHaveBeenCalledTimes(1);
  });

  it('drives the window that is live now, not the one captured at registration', () => {
    const makeWindow = () => ({
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      close: vi.fn(),
      isMaximized: vi.fn(() => false),
    });
    const stale = makeWindow();
    const live = makeWindow();
    let current: unknown = stale;

    registerWindowIpcHandlers({ getMainWindow: () => current as never });
    // macOS recreates the window on `app.on('activate')` after the user closes
    // it; the titlebar buttons must follow the new window, not the old handle.
    current = live;

    mocks.listeners.get('window.minimize')?.({});
    mocks.listeners.get('window.maximize')?.({});
    mocks.listeners.get('window.close')?.({});

    expect(live.minimize).toHaveBeenCalledTimes(1);
    expect(live.maximize).toHaveBeenCalledTimes(1);
    expect(live.close).toHaveBeenCalledTimes(1);
    expect(stale.minimize).not.toHaveBeenCalled();
    expect(stale.maximize).not.toHaveBeenCalled();
    expect(stale.close).not.toHaveBeenCalled();
  });
});
