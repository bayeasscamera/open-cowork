/**
 * Fail-fast probe for the better-sqlite3 native binding.
 *
 * Must be imported before any other better-sqlite3 load so an ABI mismatch
 * (binary compiled for Node while Electron runs, or the reverse) surfaces as
 * an actionable error instead of a bare NODE_MODULE_VERSION crash during
 * module initialization.
 */

/** True when a load failure is an ABI mismatch between Node and Electron. */
export function isNativeModuleAbiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /NODE_MODULE_VERSION/.test(message);
}

if (typeof require === 'function') {
  try {
    require('better-sqlite3');
  } catch (error) {
    if (isNativeModuleAbiError(error)) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        '[Database] better-sqlite3 was compiled for a different runtime ABI. ' +
          'Run "npm run rebuild" to restore the Electron build; "npm test" ' +
          'switches the ABI automatically for the test suite. ' +
          `Details: ${detail}`
      );
    }
    throw error;
  }
}