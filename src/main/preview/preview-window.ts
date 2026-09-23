/**
 * @module main/preview/preview-window
 *
 * A sandboxed preview window for a local dev server.
 *
 * The renderer only names a loopback http(s) URL; the URL is re-validated
 * here, the window is created with the same hardening as the app shell
 * (sandbox, context isolation, no node integration, no preload, no webview
 * tag) on its own in-memory session, and navigation, popups and permissions
 * are restricted so the window can never become a general browser for
 * untrusted origins.
 */

import { BrowserWindow } from 'electron';
import { isLoopbackHostname } from '../../shared/network/loopback';
import { log, logError, logWarn } from '../utils/logger';

/** In-memory session: preview cookies and permissions never touch the app. */
export const PREVIEW_PARTITION = 'preview';
export const DEFAULT_PREVIEW_URL = 'http://localhost:3000';

export interface PreviewWindowState {
  open: boolean;
  url: string | null;
}

export interface PreviewOpenResult {
  success: boolean;
  error?: 'invalid_url' | 'failed';
  state: PreviewWindowState;
}

/**
 * Accepts a loopback http(s) URL, with or without a scheme. Anything else
 * (another host, another protocol, unparseable input) is refused.
 */
export function normalizePreviewUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : 'http://' + trimmed;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isLoopbackHostname(url.hostname)) return null;
  return url.toString();
}

let previewWindow: BrowserWindow | null = null;

function createPreviewWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 420,
    minHeight: 320,
    title: 'Preview',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PREVIEW_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // The preview never needs camera, microphone, notifications or geolocation.
  const previewSession = window.webContents.session;
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);

  // A dev-server link that asks for a new window must not open one.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.webContents.on('will-navigate', (event, target) => {
    if (normalizePreviewUrl(target) === null) {
      event.preventDefault();
      logWarn('[preview] blocked a navigation outside loopback');
    }
  });

  window.on('closed', () => {
    previewWindow = null;
  });

  return window;
}

export function previewState(): PreviewWindowState {
  if (!previewWindow || previewWindow.isDestroyed()) {
    return { open: false, url: null };
  }
  return { open: true, url: previewWindow.webContents.getURL() || null };
}

/** Open (or retarget) the preview window. Never throws. */
export function openPreviewWindow(input: unknown): PreviewOpenResult {
  const url = normalizePreviewUrl(input);
  if (!url) {
    logWarn('[preview] refused a non-loopback or invalid preview URL');
    return { success: false, error: 'invalid_url', state: previewState() };
  }
  try {
    if (!previewWindow || previewWindow.isDestroyed()) {
      previewWindow = createPreviewWindow();
    }
    // A refused connection rejects loadURL; the window then shows Chromium's
    // own error page instead of taking the app down with an unhandled
    // rejection.
    previewWindow.loadURL(url).catch(() => {
      logWarn('[preview] the preview URL could not be loaded');
    });
    previewWindow.show();
    previewWindow.focus();
    log('[preview] opened a loopback preview window');
    return { success: true, state: { open: true, url } };
  } catch (error: unknown) {
    logError('[preview] failed to open the preview window:', error);
    return { success: false, error: 'failed', state: previewState() };
  }
}

/** Close the preview window if it is open; called from the shutdown path. */
export function closePreviewWindow(): PreviewWindowState {
  try {
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.destroy();
    }
  } catch (error: unknown) {
    logError('[preview] failed to close the preview window:', error);
  }
  previewWindow = null;
  return { open: false, url: null };
}
