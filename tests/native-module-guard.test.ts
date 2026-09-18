import { describe, expect, it } from 'vitest';
import { isNativeModuleAbiError } from '../src/main/db/native-module-guard';

describe('native-module-guard', () => {
  it('detects NODE_MODULE_VERSION ABI mismatch messages', () => {
    expect(
      isNativeModuleAbiError(
        new Error(
          'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127.'
        )
      )
    ).toBe(true);
    expect(isNativeModuleAbiError('NODE_MODULE_VERSION 145 mismatch')).toBe(true);
  });

  it('does not flag unrelated load errors', () => {
    expect(isNativeModuleAbiError(new Error("Cannot find module 'better-sqlite3'"))).toBe(false);
    expect(isNativeModuleAbiError('ENOSPC: no space left on device')).toBe(false);
  });

  it('loads without throwing when the native module is compatible', async () => {
    await expect(import('../src/main/db/native-module-guard')).resolves.toBeDefined();
  });
});