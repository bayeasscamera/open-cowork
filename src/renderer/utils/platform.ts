/**
 * Single source of truth for "which platform is the renderer running on?".
 *
 * The answer already crosses the context bridge: the preload exposes
 * `process.platform` (and `process.arch`) next to the rest of the API. Every
 * renderer component used to re-derive it on its own, in four slightly
 * different shapes:
 *
 *   const isMac = window.electronAPI?.platform === 'darwin';
 *   const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
 *   const platform = window.electronAPI?.platform || 'unknown';
 *   const isWindows = window.electronAPI?.platform === 'win32';
 *
 * Same question, four answers to keep in sync — and the two `typeof window`
 * guards exist only because one component used to read `navigator`, which does
 * not exist outside a DOM. Those variants are now one call.
 *
 * Every helper is null-safe on purpose: the renderer also boots in a browser
 * tab (`window.electronAPI` absent) during development and in tests, so a
 * missing bridge must degrade to "unknown platform" instead of throwing.
 */

/** The raw platform id, or `null` outside Electron / before the bridge loads. */
export function getPlatform(): NodeJS.Platform | null {
  return typeof window === 'undefined' ? null : (window.electronAPI?.platform ?? null);
}

/** True when running on macOS. False on every other platform, and in a browser tab. */
export function isMac(): boolean {
  return getPlatform() === 'darwin';
}

/** True when running on Windows. */
export function isWindows(): boolean {
  return getPlatform() === 'win32';
}

/** True when running on Linux (or any other non-darwin, non-win32 platform). */
export function isLinux(): boolean {
  const platform = getPlatform();
  return platform === 'linux' || (platform !== null && !isMac() && !isWindows());
}

/**
 * CPU architecture of the running app.
 *
 * Falls back to `null` rather than guessing: the architecture is displayed in
 * the settings overview, where showing a wrong value is worse than showing
 * none.
 */
export function getArch(): string | null {
  return typeof window === 'undefined' ? null : (window.electronAPI?.arch ?? null);
}