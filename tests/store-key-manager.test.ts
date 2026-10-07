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

  it('refuses to overwrite a key file it cannot decode', async () => {
    registerKeyManagerMocks({ encryptionAvailable: true });
    const { resolveStoreEncryptionKey, StoreKeyUnreadableError } = await loadManager();

    const keyPath = path.join(userDataDir, 'keyring', 'encryption-key.bin');
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const foreign = Buffer.from('a key this build cannot open');
    fs.writeFileSync(keyPath, foreign);

    expect(() => resolveStoreEncryptionKey()).toThrow(StoreKeyUnreadableError);

    // The whole point of the guard: the file is untouched. Overwriting it — what
    // this used to do — makes every secret encrypted with it, the user's
    // configured providers included, permanently undecryptable.
    expect(fs.readFileSync(keyPath)).toEqual(foreign);
  });

  it('keeps the key across a keyring outage instead of rotating it away', async () => {
    // Launch 1 — keyring available, so a key is created and persisted.
    registerKeyManagerMocks({ encryptionAvailable: true });
    const first = await loadManager();
    const originalKey = first.resolveStoreEncryptionKey();

    const keyPath = path.join(userDataDir, 'keyring', 'encryption-key.bin');
    const onDisk = fs.readFileSync(keyPath);

    // Launch 2 — keyring unavailable: a locked login keychain after the machine
    // slept, or an unreachable keyring at boot. Nothing is written.
    vi.resetModules();
    registerKeyManagerMocks({ encryptionAvailable: false });
    const second = await loadManager();
    expect(() => second.resolveStoreEncryptionKey()).toThrow(second.StoreKeyUnreadableError);
    expect(fs.readFileSync(keyPath)).toEqual(onDisk);

    // Launch 3 — keyring back. The SAME key is returned, so the config
    // encrypted with it is still readable. Before the guard, launch 2 would
    // have replaced the file with a fresh plaintext key and the config would
    // have been lost for good.
    vi.resetModules();
    registerKeyManagerMocks({ encryptionAvailable: true });
    const third = await loadManager();
    expect(third.resolveStoreEncryptionKey()).toBe(originalKey);
  });

  it('still rotates a zero-byte key file, which holds no key to lose', async () => {
    registerKeyManagerMocks({ encryptionAvailable: true });
    const { resolveStoreEncryptionKey } = await loadManager();

    const keyPath = path.join(userDataDir, 'keyring', 'encryption-key.bin');
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, Buffer.alloc(0));

    const key = resolveStoreEncryptionKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(keyPath).length).toBeGreaterThan(0);
  });
});
