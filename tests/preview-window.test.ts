import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakePreviewWindow {
    public static instances: FakePreviewWindow[] = [];
    public options: Record<string, unknown>;
    public destroyed = false;
    public shown = 0;
    public focused = 0;
    public loadCalls: string[] = [];
    public permissionRequest: ((...args: unknown[]) => void) | null = null;
    public permissionCheck: (() => boolean) | null = null;
    public windowOpen: (() => unknown) | null = null;
    public navigationHandlers: Array<
      (event: { preventDefault: () => void }, url: string) => void
    > = [];
    public closedHandlers: Array<() => void> = [];
    private url = '';

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakePreviewWindow.instances.push(this);
    }

    public webContents = {
      session: {
        setPermissionRequestHandler: (handler: (...args: unknown[]) => void) => {
          this.permissionRequest = handler;
        },
        setPermissionCheckHandler: (handler: () => boolean) => {
          this.permissionCheck = handler;
        },
      },
      setWindowOpenHandler: (handler: () => unknown) => {
        this.windowOpen = handler;
      },
      on: (event: string, listener: (event: { preventDefault: () => void }, url: string) => void) => {
        if (event === 'will-navigate') this.navigationHandlers.push(listener);
      },
      getURL: () => this.url,
    };

    public loadURL = async (url: string): Promise<void> => {
      this.loadCalls.push(url);
      this.url = url;
    };

    public show = (): void => {
      this.shown += 1;
    };

    public focus = (): void => {
      this.focused += 1;
    };

    public destroy = (): void => {
      this.destroyed = true;
    };

    public isDestroyed = (): boolean => this.destroyed;

    public on = (event: string, listener: () => void): void => {
      if (event === 'closed') this.closedHandlers.push(listener);
    };
  }
  return { FakePreviewWindow, instances: FakePreviewWindow.instances };
});

vi.mock('electron', () => ({ BrowserWindow: mocks.FakePreviewWindow }));

import {
  PREVIEW_PARTITION,
  closePreviewWindow,
  normalizePreviewUrl,
  openPreviewWindow,
  previewState,
} from '../src/main/preview/preview-window';

function lastWindow(): (typeof mocks.instances)[number] {
  return mocks.instances[mocks.instances.length - 1];
}

beforeEach(() => {
  mocks.instances.length = 0;
  closePreviewWindow();
  mocks.instances.length = 0;
});

describe('normalizePreviewUrl', () => {
  it('accepts loopback hosts with or without a scheme', () => {
    expect(normalizePreviewUrl('http://localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizePreviewUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizePreviewUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(normalizePreviewUrl('http://[::1]:3000')).toBe('http://[::1]:3000/');
  });

  it('keeps the path, query and https scheme', () => {
    expect(normalizePreviewUrl('https://localhost:3000/app?x=1')).toBe(
      'https://localhost:3000/app?x=1'
    );
  });

  it('refuses a non-loopback host', () => {
    expect(normalizePreviewUrl('http://example.com')).toBeNull();
    expect(normalizePreviewUrl('https://192.168.1.10:3000')).toBeNull();
    expect(normalizePreviewUrl('http://localhost.evil.example')).toBeNull();
  });

  it('refuses another protocol', () => {
    expect(normalizePreviewUrl('file:///etc/passwd')).toBeNull();
    expect(normalizePreviewUrl('javascript:alert(1)')).toBeNull();
    expect(normalizePreviewUrl('ftp://localhost')).toBeNull();
  });

  it('refuses blank, oversized and non-string input', () => {
    expect(normalizePreviewUrl('')).toBeNull();
    expect(normalizePreviewUrl('   ')).toBeNull();
    expect(normalizePreviewUrl(42)).toBeNull();
    expect(normalizePreviewUrl(null)).toBeNull();
    expect(normalizePreviewUrl('http://localhost/' + 'x'.repeat(2048))).toBeNull();
  });
});

describe('openPreviewWindow', () => {
  it('creates a hardened window for a loopback URL', () => {
    const result = openPreviewWindow('http://localhost:3000');
    expect(result).toEqual({
      success: true,
      state: { open: true, url: 'http://localhost:3000/' },
    });
    expect(mocks.instances).toHaveLength(1);
    const window = lastWindow();
    const webPreferences = window.options.webPreferences as Record<string, unknown>;
    expect(webPreferences.partition).toBe(PREVIEW_PARTITION);
    expect(webPreferences.sandbox).toBe(true);
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.webviewTag).toBe(false);
    expect(webPreferences.webSecurity).toBe(true);
    expect(webPreferences.preload).toBeUndefined();
    expect(window.loadCalls).toEqual(['http://localhost:3000/']);
    expect(window.shown).toBe(1);
    expect(window.focused).toBe(1);
  });

  it('refuses a non-loopback URL without creating a window', () => {
    const result = openPreviewWindow('http://example.com');
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_url');
    expect(mocks.instances).toHaveLength(0);
  });

  it('reuses the same window when retargeted', () => {
    openPreviewWindow('http://localhost:3000');
    openPreviewWindow('http://localhost:4000');
    expect(mocks.instances).toHaveLength(1);
    expect(lastWindow().loadCalls).toEqual([
      'http://localhost:3000/',
      'http://localhost:4000/',
    ]);
  });

  it('denies popups and every permission request', () => {
    openPreviewWindow('http://localhost:3000');
    const window = lastWindow();
    expect(window.windowOpen?.()).toEqual({ action: 'deny' });

    const granted: boolean[] = [];
    window.permissionRequest?.({}, 'camera', (value: boolean) => granted.push(value));
    expect(granted).toEqual([false]);
    expect(window.permissionCheck?.()).toBe(false);
  });

  it('blocks a navigation that leaves loopback', () => {
    openPreviewWindow('http://localhost:3000');
    const window = lastWindow();
    const prevented: string[] = [];
    const event = { preventDefault: () => prevented.push('blocked') };

    window.navigationHandlers[0](event, 'https://evil.example/phish');
    expect(prevented).toEqual(['blocked']);

    window.navigationHandlers[0](event, 'http://localhost:3000/next');
    expect(prevented).toEqual(['blocked']);
  });

  it('survives a refused connection without an unhandled rejection', async () => {
    openPreviewWindow('http://localhost:3000');
    lastWindow().loadURL = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = openPreviewWindow('http://localhost:9999');
    await Promise.resolve();
    expect(result.success).toBe(true);
  });
});

describe('previewState and closePreviewWindow', () => {
  it('reports the window URL while it is open', () => {
    openPreviewWindow('http://localhost:3000');
    expect(previewState()).toEqual({ open: true, url: 'http://localhost:3000/' });
  });

  it('destroys the window and reports it closed', () => {
    openPreviewWindow('http://localhost:3000');
    const window = lastWindow();
    expect(closePreviewWindow()).toEqual({ open: false, url: null });
    expect(window.destroyed).toBe(true);
    expect(previewState()).toEqual({ open: false, url: null });
  });

  it('creates a fresh window after the previous one was closed', () => {
    openPreviewWindow('http://localhost:3000');
    closePreviewWindow();
    openPreviewWindow('http://localhost:3000');
    expect(mocks.instances).toHaveLength(2);
  });

  it('drops the reference when the window closes itself', () => {
    openPreviewWindow('http://localhost:3000');
    lastWindow().closedHandlers.forEach((handler) => handler());
    expect(previewState()).toEqual({ open: false, url: null });
  });
});
