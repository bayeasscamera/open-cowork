/**
 * Per-installation encryption key for electron-store data (API keys etc.).
 *
 * Previous scheme: scrypt over PUBLIC constants + hostname — anyone with the
 * app binary and the machine name could re-derive the key. This module keeps
 * a random 32-byte key per installation, protected by the OS credential
 * store via Electron safeStorage (Keychain / DPAPI / libsecret). If the OS
 * credential store is unavailable, it falls back to the previous derivation
 * so behavior is never worse than before.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app, safeStorage } from 'electron';

const KEY_FILE_NAME = 'encryption-key.bin';
const KEY_LENGTH_BYTES = 32;
const MAGIC_PLAINTEXT = Buffer.from('COWORKPLAINKEY1');

/**
 * A key file is present but this process cannot decode it.
 *
 * Raised instead of rotating, because an undecodable key file is evidence
 * about *this process*, not about the key. `safeStorage.decryptString` also
 * fails when the keychain entry is denied to a re-signed build, when the login
 * keychain is still locked after the machine slept, or when the OS keyring is
 * briefly unreachable during boot — and in every one of those the key itself is
 * perfectly intact.
 *
 * Callers must therefore treat this as "cannot read right now", never as "the
 * stored data is unusable". Leaving the file untouched is what lets the next
 * launch recover.
 */
export class StoreKeyUnreadableError extends Error {
  readonly keyPath: string;

  constructor(keyPath: string, reason: string) {
    super(`Store encryption key is present but unreadable (${reason}): ${keyPath}`);
    this.name = 'StoreKeyUnreadableError';
    this.keyPath = keyPath;
  }
}

function resolveKeyDir(): string {
  try {
    if (app && typeof app.getPath === 'function') {
      const userDataPath = app.getPath('userData');
      if (userDataPath?.trim()) {
        return path.join(userDataPath, 'keyring');
      }
    }
  } catch {
    // Fall through to cwd-based path (test/dev contexts)
  }
  return path.join(process.cwd(), '.cowork-user-data', 'keyring');
}

function readKeyFile(keyPath: string): Buffer | null {
  try {
    if (!fs.existsSync(keyPath)) {
      return null;
    }
    return fs.readFileSync(keyPath);
  } catch {
    return null;
  }
}

function writeKeyFileAtomic(keyPath: string, data: Buffer): void {
  const dir = path.dirname(keyPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${keyPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, data, { mode: 0o600 });
  fs.renameSync(tmpPath, keyPath);
}

function generateNewKey(safeStorageAvailable: boolean): { raw: string; file: Buffer } {
  const rawKey = crypto.randomBytes(KEY_LENGTH_BYTES).toString('hex');
  const file = safeStorageAvailable
    ? safeStorage.encryptString(rawKey)
    : Buffer.concat([MAGIC_PLAINTEXT, Buffer.from(rawKey, 'utf8')]);
  return { raw: rawKey, file };
}

function decodeKeyFile(contents: Buffer, safeStorageAvailable: boolean): string | null {
  if (contents.subarray(0, MAGIC_PLAINTEXT.length).equals(MAGIC_PLAINTEXT)) {
    // Plaintext fallback format (OS keyring unavailable at write time)
    return contents.subarray(MAGIC_PLAINTEXT.length).toString('utf8') || null;
  }
  if (!safeStorageAvailable) {
    // Cannot decrypt a keyring-protected key without the OS service
    return null;
  }
  try {
    return safeStorage.decryptString(contents) || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the per-installation store encryption key.
 * Creates and persists a fresh random key on first run.
 */
export function resolveStoreEncryptionKey(): string {
  const keyDir = resolveKeyDir();
  const keyPath = path.join(keyDir, KEY_FILE_NAME);

  let safeStorageAvailable = false;
  try {
    safeStorageAvailable = safeStorage.isEncryptionAvailable();
  } catch {
    safeStorageAvailable = false;
  }

  const existing = readKeyFile(keyPath);
  // A zero-byte file holds no key, so replacing it destroys nothing — treat it
  // exactly like an absent file. Anything else is a key we must not touch.
  if (existing && existing.length > 0) {
    const key = decodeKeyFile(existing, safeStorageAvailable);
    if (key) {
      return key;
    }

    // Deliberately NO rotation here.
    //
    // This function used to generate a fresh key and overwrite the file. That
    // turned a read failure into permanent data loss: `config.json` is
    // encrypted with this key, so replacing it makes every stored secret — the
    // user's configured providers included — undecryptable, and the store's own
    // recovery path can only move the file aside and restart from defaults.
    // The key file stays exactly where it is, so the next launch retries it.
    throw new StoreKeyUnreadableError(
      keyPath,
      safeStorageAvailable ? 'the OS keyring rejected it' : 'the OS keyring is unavailable'
    );
  }

  const { raw, file } = generateNewKey(safeStorageAvailable);
  try {
    writeKeyFileAtomic(keyPath, file);
  } catch {
    // Persist as best effort; without the file the key regenerates per run,
    // but stores still function via the legacy recovery path.
  }
  return raw;
}
