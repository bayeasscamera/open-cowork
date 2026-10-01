/**
 * @module main/utils/updater-resolve
 *
 * Resolve the `autoUpdater` instance from a dynamic `import('electron-updater')`
 * regardless of CJS/ESM interop shape.
 *
 * electron-updater defines `autoUpdater` as a lazy getter on its CJS exports,
 * which ESM namespace interop does not detect: under the vite bundle the
 * namespace carries only `default` (the full `module.exports`), so blind
 * destructuring yields `undefined` and silently disables updates on every
 * production boot. Both shapes resolve here; anything else returns null so the
 * caller skips the update check loudly instead of crashing on `.undefined`.
 */

export interface AutoUpdaterLike {
  checkForUpdatesAndNotify(): Promise<unknown>;
}

interface UpdaterNamespace {
  autoUpdater?: AutoUpdaterLike;
  default?: { autoUpdater?: AutoUpdaterLike };
}

export function resolveAutoUpdater(mod: unknown): AutoUpdaterLike | null {
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) {
    return null;
  }
  const namespace = mod as UpdaterNamespace;
  const direct = namespace.autoUpdater;
  if (direct && typeof direct.checkForUpdatesAndNotify === 'function') {
    return direct;
  }
  const throughDefault = namespace.default?.autoUpdater;
  if (throughDefault && typeof throughDefault.checkForUpdatesAndNotify === 'function') {
    return throughDefault;
  }
  return null;
}
