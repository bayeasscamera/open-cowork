import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, fn),
  },
}));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../src/main/preview/preview-window', () => ({
  openPreviewWindow: vi.fn(() => ({
    success: true,
    state: { open: true, url: 'http://localhost:3000/' },
  })),
  closePreviewWindow: vi.fn(() => ({ open: false, url: null })),
  previewState: vi.fn(() => ({ open: false, url: null })),
}));

import { registerPreviewIpcHandlers } from '../src/main/ipc/preview-handlers';
import {
  closePreviewWindow,
  openPreviewWindow,
  previewState,
} from '../src/main/preview/preview-window';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error('no handler for ' + channel);
  return handler({}, ...args);
};

describe('preview IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.mocked(openPreviewWindow).mockClear();
    vi.mocked(previewState).mockClear();
    registerPreviewIpcHandlers();
  });

  it('registers the preview surface', () => {
    expect(Array.from(mocks.handlers.keys()).sort()).toEqual([
      'preview.close',
      'preview.open',
      'preview.state',
    ]);
  });

  it('delegates open, close and state', async () => {
    expect(await invoke('preview.open', 'http://localhost:3000')).toEqual({
      success: true,
      state: { open: true, url: 'http://localhost:3000/' },
    });
    expect(openPreviewWindow).toHaveBeenCalledWith('http://localhost:3000');
    expect(await invoke('preview.state')).toEqual({ open: false, url: null });
    expect(await invoke('preview.close')).toEqual({ open: false, url: null });
    expect(closePreviewWindow).toHaveBeenCalled();
  });

  it('reports a failure instead of throwing when opening breaks', async () => {
    vi.mocked(openPreviewWindow).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(await invoke('preview.open', 'http://localhost:3000')).toEqual({
      success: false,
      error: 'failed',
      state: { open: false, url: null },
    });
  });

  it('reports a closed state when reading the state breaks', async () => {
    vi.mocked(previewState).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(await invoke('preview.state')).toEqual({ open: false, url: null });
  });
});
