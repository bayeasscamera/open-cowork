import * as os from 'os';
import * as path from 'path';

export const PLATFORM = os.platform(); // 'darwin' for macOS, 'win32' for Windows


// Get Open Cowork data directory for persistent storage
// Use platform-appropriate paths:
// - macOS: ~/Library/Application Support/open-cowork
// - Windows: %APPDATA%/open-cowork
export const OPEN_COWORK_DATA_DIR =
  PLATFORM === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'open-cowork')
    : path.join(os.homedir(), 'Library', 'Application Support', 'open-cowork');

// Directory for storing GUI operate files (screenshots, etc.)
export const GUI_OPERATE_DIR = path.join(OPEN_COWORK_DATA_DIR, 'gui_operate');
export const SCREENSHOTS_DIR = path.join(GUI_OPERATE_DIR, 'screenshots');
export const SCREENSHOT_REUSE_WINDOW_MS = 5 * 60_000;
export const OPENAI_PLATFORM_BASE_URL = 'https://api.openai.com/v1';

export type ScreenshotCacheEntry = {
  displayIndex: number;
  regionKey: string;
  path: string;
  base64Image: string;
  capturedAt: number;
  displayInfo: { width: number; height: number; scaleFactor: number };
};

export let lastScreenshotCache: ScreenshotCacheEntry | null = null;
export const screenshotRequestCounts = new Map<string, number>();

// ============================================================================
// Click History Tracking for GUI Locate (App-level Persistent Storage)
// ============================================================================

export interface ClickHistoryEntry {
  index: number;
  x: number; // Logical coordinates (runtime, scaled to current display)
  y: number;
  displayIndex: number;
  timestamp: number;
  operation: string; // 'click', 'double_click', 'right_click', etc.
  count: number; // Number of times this coordinate was clicked
  successCount: number; // Number of times this click led to successful operations
}

export interface StoredClickHistoryEntry {
  index: number;
  x_normalized: number; // Normalized coordinates (0-1000, stored on disk)
  y_normalized: number;
  displayIndex: number;
  displayWidth: number; // Display dimensions when click was recorded
  displayHeight: number;
  timestamp: number;
  operation: string;
  count: number;
  successCount: number; // Number of times this click led to successful operations
}

export interface AppClickHistory {
  appName: string;
  lastUpdated: number;
  clicks: StoredClickHistoryEntry[]; // Stored with normalized coordinates
  counter: number;
}

export interface DockItemInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}



export const APP_NAME_ALIAS_GROUPS: string[][] = [
  ['calendar', '日历'],
  ['notes', '备忘录'],
  ['music', '音乐'],
  ['finder', '访达'],
  ['system settings', 'settings', '系统设置'],
  ['ticktick', '滴答清单'],
  ['wechat', '微信'],
  ['trash', '废纸篓'],
  ['chrome', 'google chrome'],
];

// Base directory for storing app-level data
export const GUI_APPS_DIR = path.join(OPEN_COWORK_DATA_DIR, 'gui_apps');
export const GUI_LAST_APP_FILE = path.join(GUI_APPS_DIR, '_last_app.json');

export interface LastAppContext {
  appName: string;
  savedAt: number;
}


// ============================================================================
// Display Information Types
// ============================================================================

export interface DisplayInfo {
  index: number;
  name: string;
  isMain: boolean;
  width: number;
  height: number;
  originX: number; // Global coordinate origin X
  originY: number; // Global coordinate origin Y
  scaleFactor: number; // Retina scale factor
}

export interface DisplayConfiguration {
  displays: DisplayInfo[];
  totalWidth: number;
  totalHeight: number;
  mainDisplayIndex: number;
}

export function toRegionKey(region?: { x: number; y: number; width: number; height: number }): string {
  if (!region) {
    return 'full';
  }
  return `${region.x},${region.y},${region.width},${region.height}`;
}

export function getReusableScreenshot(
  displayIndex: number,
  regionKey: string
): ScreenshotCacheEntry | null {
  if (!lastScreenshotCache) {
    return null;
  }
  if (lastScreenshotCache.displayIndex !== displayIndex) {
    return null;
  }
  if (lastScreenshotCache.regionKey !== regionKey) {
    return null;
  }
  const age = Date.now() - lastScreenshotCache.capturedAt;
  if (age > SCREENSHOT_REUSE_WINDOW_MS) {
    return null;
  }
  return lastScreenshotCache;
}

export function updateScreenshotCache(entry: ScreenshotCacheEntry): void {
  lastScreenshotCache = entry;
}
