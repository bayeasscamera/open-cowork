import * as fs from 'fs/promises';
import * as path from 'path';

import { writeMCPLog } from '../mcp-logger.js';
import { getDisplayConfiguration } from './display-coords.js';
import {
  GUI_APPS_DIR,
  GUI_LAST_APP_FILE,
  APP_NAME_ALIAS_GROUPS,
  type ClickHistoryEntry,
  type StoredClickHistoryEntry,
  type AppClickHistory,
  type LastAppContext,
} from './state.js';

// Store click history for current session (in-memory cache)
export let clickHistory: ClickHistoryEntry[] = [];
export let clickHistoryCounter = 0;
export let currentAppName: string = '';
export let lastClickEntry: ClickHistoryEntry | null = null;
export let restoreAppContextPromise: Promise<boolean> | null = null;

export async function saveLastAppContext(appName: string): Promise<void> {
  try {
    await fs.mkdir(GUI_APPS_DIR, { recursive: true });
    const payload: LastAppContext = { appName, savedAt: Date.now() };
    await fs.writeFile(GUI_LAST_APP_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error: unknown) {
    writeMCPLog(
      `[App Context] Failed to save last app context: ${error instanceof Error ? error.message : String(error)}`,
      'App Init Warning'
    );
  }
}

export async function inferMostRecentAppNameFromDisk(): Promise<string | null> {
  try {
    await fs.mkdir(GUI_APPS_DIR, { recursive: true });
    const entries = await fs.readdir(GUI_APPS_DIR, { withFileTypes: true });

    let best: { appDirName: string; lastUpdated: number } | null = null;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const clickHistoryPath = path.join(GUI_APPS_DIR, entry.name, 'click_history.json');

      try {
        const raw = await fs.readFile(clickHistoryPath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<AppClickHistory> | null;
        const lastUpdated = typeof parsed?.lastUpdated === 'number' ? parsed.lastUpdated : 0;

        if (!best || lastUpdated > best.lastUpdated) {
          best = { appDirName: entry.name, lastUpdated };
        }
      } catch {
        // ignore
      }
    }

    return best?.appDirName ?? null;
  } catch {
    return null;
  }
}

export async function restoreLastAppContext(): Promise<boolean> {
  if (currentAppName) return true;

  try {
    const data = await fs.readFile(GUI_LAST_APP_FILE, 'utf-8');
    const parsed = JSON.parse(data) as Partial<LastAppContext> | null;
    const appName = typeof parsed?.appName === 'string' ? parsed.appName : '';

    if (!appName) {
      const inferred = await inferMostRecentAppNameFromDisk();
      if (!inferred) return false;
      writeMCPLog(
        `[App Context] No appName in last-app file. Inferred most recent app: "${inferred}"`,
        'App Init Warning'
      );
      await loadClickHistoryForApp(inferred);
      await saveLastAppContext(inferred);
      return true;
    }

    writeMCPLog(`[App Context] Restoring last app context: "${appName}"`, 'App Init');
    await loadClickHistoryForApp(appName);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Backward compatibility: if we don't have last-app metadata yet, infer from disk.
      const inferred = await inferMostRecentAppNameFromDisk();
      if (!inferred) return false;
      writeMCPLog(
        `[App Context] No last-app file found. Inferred most recent app: "${inferred}"`,
        'App Init'
      );
      await loadClickHistoryForApp(inferred);
      await saveLastAppContext(inferred);
      return true;
    }
    writeMCPLog(
      `[App Context] Failed to restore last app context: ${error instanceof Error ? error.message : String(error)}`,
      'App Init Warning'
    );
    return false;
  }
}

export async function ensureAppContextRestored(): Promise<boolean> {
  if (currentAppName) return true;
  if (!restoreAppContextPromise) {
    restoreAppContextPromise = restoreLastAppContext();
  }
  const restored = await restoreAppContextPromise;
  // If restore failed and app is still not initialized, allow future retries (e.g. after init_app creates metadata).
  if (!restored && !currentAppName) {
    restoreAppContextPromise = null;
  }
  return restored;
}

export function normalizeText(text: string): string {
  return text.toLowerCase().trim();
}

export function compactText(text: string): string {
  return normalizeText(text).replace(/[\s_-]+/g, '');
}

export function inferExpectedAppAliasesFromText(text: string): string[] {
  const normalized = normalizeText(text);
  const compact = compactText(text);
  const aliases = new Set<string>();

  for (const group of APP_NAME_ALIAS_GROUPS) {
    const normalizedGroup = group.map((token) => normalizeText(token));
    const compactGroup = group.map((token) => compactText(token));
    const matched =
      normalizedGroup.some((token) => token && normalized.includes(token)) ||
      compactGroup.some((token) => token && compact.includes(token));

    if (matched) {
      for (const token of normalizedGroup) {
        if (token) aliases.add(token);
      }
      for (const token of compactGroup) {
        if (token) aliases.add(token);
      }
    }
  }

  return Array.from(aliases);
}

export function getAliasTokensForAppName(appName: string): string[] {
  const normalizedName = normalizeText(appName);
  const compactName = compactText(appName);
  const tokens = new Set<string>([normalizedName, compactName]);

  for (const group of APP_NAME_ALIAS_GROUPS) {
    const normalizedGroup = group.map((token) => normalizeText(token));
    const compactGroup = group.map((token) => compactText(token));
    const matched = normalizedGroup.includes(normalizedName) || compactGroup.includes(compactName);
    if (!matched) continue;

    for (const token of normalizedGroup) {
      if (token) tokens.add(token);
    }
    for (const token of compactGroup) {
      if (token) tokens.add(token);
    }
  }

  return Array.from(tokens).filter(
    (token) => token && token !== 'null' && token !== 'missingvalue'
  );
}

export function scoreDockItemAgainstDescription(itemName: string, description: string): number {
  const normalizedDescription = normalizeText(description);
  const compactDescription = compactText(description);
  const tokens = getAliasTokensForAppName(itemName);
  let bestScore = 0;

  for (const token of tokens) {
    if (token.length < 2) continue;

    if (normalizedDescription.includes(token)) {
      bestScore = Math.max(bestScore, 120 + token.length);
    }

    const compactToken = compactText(token);
    if (compactToken.length >= 2 && compactDescription.includes(compactToken)) {
      bestScore = Math.max(bestScore, 110 + compactToken.length);
    }
  }

  return bestScore;
}

export function isDescriptionDockRelated(description: string): boolean {
  const normalized = normalizeText(description);
  return /dock|下边栏|程序坞|底栏/.test(normalized);
}

export function isLikelyAppLaunchVerification(question: string): boolean {
  const normalized = normalizeText(question);
  const mentionsApp = /(app|application|应用|程序|软件)/i.test(normalized);
  const mentionsMenuLike = /(menu|菜单|弹窗|popup|面板|widget|小组件|下拉)/i.test(normalized);
  return mentionsApp && !mentionsMenuLike;
}

export function appNameMatchesAliases(appName: string, aliases: string[]): boolean {
  const normalizedName = normalizeText(appName);
  const compactName = compactText(appName);

  return aliases.some((alias) => {
    const normalizedAlias = normalizeText(alias);
    const compactAlias = compactText(alias);

    return (
      (normalizedAlias &&
        (normalizedName.includes(normalizedAlias) || normalizedAlias.includes(normalizedName))) ||
      (compactAlias && (compactName.includes(compactAlias) || compactAlias.includes(compactName)))
    );
  });
}

/**
 * Get the directory path for a specific app
 */
export function getAppDirectory(appName: string): string {
  // Sanitize app name for use in directory name
  const sanitizedName = appName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  return path.join(GUI_APPS_DIR, sanitizedName);
}

/**
 * Get the file path for storing click history for a specific app
 */
export function getAppClickHistoryFilePath(appName: string): string {
  return path.join(getAppDirectory(appName), 'click_history.json');
}

/**
 * Get all visited apps (apps that have directories in gui_apps)
 */
export async function getAllVisitedApps(): Promise<string[]> {
  try {
    // Ensure directory exists
    await fs.mkdir(GUI_APPS_DIR, { recursive: true });

    // Read all directories in gui_apps
    const entries = await fs.readdir(GUI_APPS_DIR, { withFileTypes: true });

    // Filter directories and read their click_history.json to get actual app names
    const actualAppNames: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          actualAppNames.push(entry.name);
          writeMCPLog(`[getAllVisitedApps] Found app: ${entry.name}`, 'App List');
        } catch (error) {
          // Skip directories without valid click_history.json
          continue;
        }
      }
    }

    writeMCPLog(`[getAllVisitedApps] Found ${actualAppNames.length} visited apps`, 'App List');
    return actualAppNames;
  } catch (error: unknown) {
    writeMCPLog(
      `[getAllVisitedApps] Error reading visited apps: ${error instanceof Error ? error.message : String(error)}`,
      'App List Error'
    );
    return [];
  }
}

/**
 * Load click history from disk for a specific app
 * Converts normalized coordinates (0-1000) to current display's logical coordinates
 */
export async function loadClickHistoryForApp(appName: string): Promise<void> {
  try {
    // Ensure app directory exists
    const appDir = getAppDirectory(appName);
    await fs.mkdir(appDir, { recursive: true });

    const filePath = getAppClickHistoryFilePath(appName);

    try {
      const data = await fs.readFile(filePath, 'utf-8');
      let appHistory: AppClickHistory;
      try {
        appHistory = JSON.parse(data);
      } catch {
        writeMCPLog(
          `[ClickHistory] Failed to parse click history JSON for app "${appName}", starting fresh`,
          'Click History Parse Error'
        );
        clickHistory = [];
        clickHistoryCounter = 0;
        currentAppName = appName;
        return;
      }

      // Basic shape validation
      if (!appHistory || typeof appHistory !== 'object' || !Array.isArray(appHistory.clicks)) {
        writeMCPLog(
          `[ClickHistory] Invalid click history shape for app "${appName}", starting fresh`,
          'Click History Parse Error'
        );
        clickHistory = [];
        clickHistoryCounter = 0;
        currentAppName = appName;
        return;
      }

      // Get current display configuration
      const config = await getDisplayConfiguration();

      // Convert stored normalized coordinates to current display's logical coordinates
      clickHistory = [];
      for (const storedClick of appHistory.clicks || []) {
        // Find the display for this click
        const display = config.displays.find((d) => d.index === storedClick.displayIndex);
        if (!display) {
          writeMCPLog(
            `[ClickHistory] Display ${storedClick.displayIndex} not found, skipping click #${storedClick.index}`,
            'Click History Load Warning'
          );
          continue;
        }

        // Convert normalized coordinates (0-1000) to logical coordinates
        // x_normalized and y_normalized are in range [0, 1000]
        // We need to scale them to the current display's dimensions
        const x = Math.round((storedClick.x_normalized / 1000) * display.width);
        const y = Math.round((storedClick.y_normalized / 1000) * display.height);

        clickHistory.push({
          index: storedClick.index,
          x: x,
          y: y,
          displayIndex: storedClick.displayIndex,
          timestamp: storedClick.timestamp,
          operation: storedClick.operation,
          count: storedClick.count,
          successCount: storedClick.successCount || 0, // Default to 0 for backward compatibility
        });

        writeMCPLog(
          `[ClickHistory] Loaded click #${storedClick.index}: normalized (${storedClick.x_normalized}, ${storedClick.y_normalized}) → logical (${x}, ${y}) on display ${storedClick.displayIndex} (${display.width}x${display.height})`,
          'Click History Load'
        );
      }

      clickHistoryCounter = appHistory.counter || 0;
      currentAppName = appName;

      writeMCPLog(
        `[ClickHistory] Loaded ${clickHistory.length} clicks for app "${appName}" from ${filePath}`,
        'Click History Load'
      );
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist, start fresh
        clickHistory = [];
        clickHistoryCounter = 0;
        currentAppName = appName;
        writeMCPLog(
          `[ClickHistory] No existing history for app "${appName}", starting fresh`,
          'Click History Load'
        );
      } else {
        throw error;
      }
    }
  } catch (error: unknown) {
    writeMCPLog(
      `[ClickHistory] Error loading history: ${error instanceof Error ? error.message : String(error)}`,
      'Click History Load Error'
    );
    // Fallback to empty history
    clickHistory = [];
    clickHistoryCounter = 0;
    currentAppName = appName;
  }
}

/**
 * Save the latest click to disk for the current app
 * Only updates the most recent click entry, merging if coordinates match
 * By default, this increments the stored click count when merging.
 * Set { incrementCount: false } to persist metadata updates (e.g. successCount) without changing click count.
 */
export async function saveLatestClickToHistory(
  latestClick: ClickHistoryEntry,
  options: { incrementCount?: boolean } = {}
): Promise<void> {
  const incrementCount = options.incrementCount !== false;
  if (!currentAppName) {
    writeMCPLog('[ClickHistory] No app initialized, skipping save', 'Click History Save');
    return;
  }

  try {
    // Ensure app directory exists
    const appDir = getAppDirectory(currentAppName);
    await fs.mkdir(appDir, { recursive: true });

    const filePath = getAppClickHistoryFilePath(currentAppName);

    // Read existing history from disk
    let existingHistory: AppClickHistory;
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      existingHistory = JSON.parse(data);
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist, create new history
        existingHistory = {
          appName: currentAppName,
          lastUpdated: Date.now(),
          clicks: [],
          counter: 0,
        };
      } else {
        throw error;
      }
    }

    // Get current display configuration
    const config = await getDisplayConfiguration();
    const display = config.displays.find((d) => d.index === latestClick.displayIndex);

    if (!display) {
      writeMCPLog(
        `[ClickHistory] Display ${latestClick.displayIndex} not found, skipping save`,
        'Click History Save Warning'
      );
      return;
    }

    // Convert logical coordinates to normalized coordinates (0-1000)
    const x_normalized = Math.round((latestClick.x / display.width) * 1000);
    const y_normalized = Math.round((latestClick.y / display.height) * 1000);

    // Check if this coordinate already exists in the stored history
    const existingClickIndex = existingHistory.clicks.findIndex(
      (click) =>
        click.x_normalized === x_normalized &&
        click.y_normalized === y_normalized &&
        click.displayIndex === latestClick.displayIndex
    );

    if (existingClickIndex !== -1) {
      // Coordinate exists, merge (optionally incrementing count)
      if (incrementCount) {
        existingHistory.clicks[existingClickIndex].count++;
      }
      existingHistory.clicks[existingClickIndex].timestamp = latestClick.timestamp;
      existingHistory.clicks[existingClickIndex].operation = latestClick.operation;
      existingHistory.clicks[existingClickIndex].successCount = latestClick.successCount || 0;

      writeMCPLog(
        `[ClickHistory] Merged click at normalized (${x_normalized}, ${y_normalized}), count: ${existingHistory.clicks[existingClickIndex].count}, successCount: ${existingHistory.clicks[existingClickIndex].successCount}${incrementCount ? '' : ' (count not incremented)'}`,
        'Click History Save'
      );
    } else {
      // New coordinate, add to history
      const newStoredClick: StoredClickHistoryEntry = {
        index: latestClick.index,
        x_normalized: x_normalized,
        y_normalized: y_normalized,
        displayIndex: latestClick.displayIndex,
        displayWidth: display.width,
        displayHeight: display.height,
        timestamp: latestClick.timestamp,
        operation: latestClick.operation,
        count: latestClick.count,
        successCount: latestClick.successCount || 0, // Default to 0
      };

      existingHistory.clicks.push(newStoredClick);
      existingHistory.counter = latestClick.index;

      writeMCPLog(
        `[ClickHistory] Added new click #${latestClick.index}: logical (${latestClick.x}, ${latestClick.y}) → normalized (${x_normalized}, ${y_normalized}) on display ${latestClick.displayIndex}`,
        'Click History Save'
      );
    }

    // Update metadata
    existingHistory.lastUpdated = Date.now();

    // Write back to disk
    await fs.writeFile(filePath, JSON.stringify(existingHistory, null, 2), 'utf-8');

    writeMCPLog(
      `[ClickHistory] Saved latest click for app "${currentAppName}" to ${filePath}`,
      'Click History Save'
    );
  } catch (error: unknown) {
    writeMCPLog(
      `[ClickHistory] Error saving latest click: ${error instanceof Error ? error.message : String(error)}`,
      'Click History Save Error'
    );
  }
}

/**
 * Initialize app context for GUI operations
 * This should be called before starting GUI operations on a new app.
 *
 * This also loads an optional per-app guide file at `<appDirectory>/guide.md` (if present)
 * and returns its contents so the agent can follow app-specific instructions.
 */
export async function initApp(appName: string): Promise<{
  appName: string;
  clickCount: number;
  isNew: boolean;
  appDirectory: string;
  hasGuide: boolean;
  guidePath: string;
  guide: string | null;
}> {
  // No need to save when switching apps - each click is saved individually

  // Check if this is a new app (no existing directory or click_history.json)
  const appDir = getAppDirectory(appName);
  const filePath = getAppClickHistoryFilePath(appName);
  let isNew = false;
  try {
    await fs.access(filePath);
  } catch {
    isNew = true;
  }

  // Load history for the target app
  await loadClickHistoryForApp(appName);
  await saveLastAppContext(appName);

  // Load optional per-app guide
  const guidePath = path.join(appDir, 'guide.md');
  let guide: string | null = null;
  let hasGuide = false;
  try {
    guide = await fs.readFile(guidePath, 'utf-8');
    hasGuide = true;
    writeMCPLog(
      `[App Init] Loaded guide.md for app "${appName}" (${guide.length} chars)`,
      'App Init'
    );
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      writeMCPLog(
        `[App Init] Failed to read guide.md for app "${appName}": ${error.message}`,
        'App Init Warning'
      );
    }
  }

  writeMCPLog(
    `[App Init] Initialized for app "${appName}" with ${clickHistory.length} existing clicks (new: ${isNew})`,
    'App Init'
  );
  writeMCPLog(`[App Init] App directory: ${appDir}`, 'App Init');

  return {
    appName: appName,
    clickCount: clickHistory.length,
    isNew: isNew,
    appDirectory: appDir,
    hasGuide,
    guidePath,
    guide,
  };
}

/**
 * Add a click to history
 * If the same coordinate already exists, increment its count instead of adding a new entry
 * Automatically saves the latest click to disk
 */
export async function addClickToHistory(
  x: number,
  y: number,
  displayIndex: number,
  operation: string
): Promise<void> {
  // Check if this coordinate already exists in history
  const existingEntry = clickHistory.find(
    (entry) => entry.x === x && entry.y === y && entry.displayIndex === displayIndex
  );

  let latestClick: ClickHistoryEntry;

  if (existingEntry) {
    // Increment count for existing coordinate
    existingEntry.count++;
    existingEntry.timestamp = Date.now(); // Update timestamp
    existingEntry.operation = operation; // Update operation type
    latestClick = existingEntry;
    writeMCPLog(
      `[ClickHistory] Updated click at (${x}, ${y}) on display ${displayIndex}, count: ${existingEntry.count}`,
      'Click History'
    );
  } else {
    // Add new coordinate
    clickHistoryCounter++;
    latestClick = {
      index: clickHistoryCounter,
      x,
      y,
      displayIndex,
      timestamp: Date.now(),
      operation,
      count: 1,
      successCount: 0, // Initialize to 0
    };
    clickHistory.push(latestClick);
    writeMCPLog(
      `[ClickHistory] Added click #${clickHistoryCounter} at (${x}, ${y}) on display ${displayIndex}`,
      'Click History'
    );
  }

  // Track this as the most recent click for success verification
  lastClickEntry = latestClick;

  // Save only the latest click to disk
  await saveLatestClickToHistory(latestClick);
}

/**
 * Get click history for a specific display
 */
export function getClickHistoryForDisplay(displayIndex: number): ClickHistoryEntry[] {
  return clickHistory.filter((entry) => entry.displayIndex === displayIndex);
}

/**
 * Clear click history for the current app
 */
/**
 * Clear click history for the current app
 */
export async function clearClickHistory(): Promise<void> {
  clickHistory.length = 0;
  clickHistoryCounter = 0;
  writeMCPLog('[ClickHistory] Cleared all click history', 'Click History');

  // Delete the click history file from disk
  if (currentAppName) {
    try {
      const filePath = getAppClickHistoryFilePath(currentAppName);
      await fs.unlink(filePath);
      writeMCPLog(`[ClickHistory] Deleted click history file: ${filePath}`, 'Click History');
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        writeMCPLog(
          `[ClickHistory] Error deleting click history file: ${error.message}`,
          'Click History Error'
        );
      }
    }
  }
}
