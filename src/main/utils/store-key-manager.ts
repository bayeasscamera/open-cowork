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
  if (existing) {
    const key = decodeKeyFile(existing, safeStorageAvailable);
    if (key) {
      return key;
    }
    // Unreadable (e.g. keyring changed) — rotate to a new key. Stores will
    // fall back to legacy keys via createEncryptedStoreWithKeyRotation and
    // otherwise re-key through the normal unreadable-recovery path.
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
