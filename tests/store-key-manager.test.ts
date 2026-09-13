import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir: string;

function registerKeyManagerMocks(opts: { encryptionAvailable: boolean }): void {
  vi.doMock('electron', () => ({
    app: {
      getPath: (name: string) => {
        if (name !== 'userData') {
          throw new Error(`Unexpected path request: ${name}`);
        }
        return userDataDir;
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => opts.encryptionAvailable,
      encryptString: (plain: string) => Buffer.concat([Buffer.from('OSK'), Buffer.from(plain)]),
      decryptString: (buf: Buffer) => {
        if (!buf.subarray(0, 3).equals(Buffer.from('OSK'))) {
          throw new Error('not keyring-protected');
        }
        return buf.subarray(3).toString('utf8');
      },
    },
  }));
}

async function loadManager() {
  return import('../src/main/utils/store-key-manager');
}

beforeEach(() => {
  vi.resetModules();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-keyring-'));
});

afterEach(() => {
  vi.doUnmock('electron');
  vi.restoreAllMocks();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('store key manager', () => {
  it('creates a random key and persists it protected by safeStorage', async () => {
    registerKeyManagerMocks({ encryptionAvailable: true });
    const { resolveStoreEncryptionKey } = await loadManager();

    const key1 = resolveStoreEncryptionKey();
    expect(key1).toMatch(/^[0-9a-f]{64}$/);

    const keyPath = path.join(userDataDir, 'keyring', 'encryption-key.bin');
    const persisted = fs.readFileSync(keyPath);
    expect(persisted.subarray(0, 3).equals(Buffer.from('OSK'))).toBe(true);

    const key2 = resolveStoreEncryptionKey();
    expect(key2).toBe(key1);
  });

  it('falls back to a plaintext key file when safeStorage is unavailable', async () => {
    registerKeyManagerMocks({ encryptionAvailable: false });
    const { resolveStoreEncryptionKey } = await loadManager();

    const key1 = resolveStoreEncryptionKey();
    expect(key1).toMatch(/^[0-9a-f]{64}$/);

    const keyPath = path.join(userDataDir, 'keyring', 'encryption-key.bin');
    const persisted = fs.readFileSync(keyPath);
    expect(persisted.subarray(0, 3).equals(Buffer.from('OSK'))).toBe(false);

    expect(resolveStoreEncryptionKey()).toBe(key1);
  });

  it('returns distinct keys for distinct installations', async () => {
    registerKeyManagerMocks({ encryptionAvailable: true });
    const { resolveStoreEncryptionKey } = await loadManager();
    const keyA = resolveStoreEncryptionKey();

    vi.resetModules();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-keyring-'));
    const { resolveStoreEncryptionKey: resolve2 } = await loadManager();
    const keyB = resolve2();

    expect(keyA).not.toBe(keyB);
  });
});
