/**
 * @module main/utils/window-theme
 *
 * Window chrome theme helpers shared by the app entry point and the client
 * event dispatcher: resolve the effective dark/light theme and keep the native
 * window background in sync with the renderer palette.
 */

import { nativeTheme } from 'electron';
import type { AppTheme } from '../config/config-store';

/** Window background color for the dark palette. */
export const DARK_BG = '#171614';

/** Window background color for the light palette. */
export const LIGHT_BG = '#f5f3ee';

export function resolveEffectiveTheme(theme: AppTheme): 'dark' | 'light' {
  if (theme === 'system') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }
  return theme;
}

export function applyNativeThemePreference(theme: AppTheme): void {
  nativeTheme.themeSource = theme;
}
