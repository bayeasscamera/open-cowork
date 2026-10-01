/**
 * @module main/memory/memory-file-crypto
 *
 * Encryption at rest for the memory JSON files (experience, core, session
 * state). Transcripts are already redacted at ingestion, but redaction is
 * pattern-based and can miss — encryption is the second layer, so a stolen
 * laptop or a synced folder does not hand over chat history in cleartext.
 *
 * Design:
 *  - AES-256-GCM per file, random 96-bit IV per write, envelope JSON with a
 *    version marker (`enc: 'cowork-aes-256-gcm-v1'`).
 *  - One data-encryption key (DEK) per storage directory, itself wrapped by
 *    the OS keychain via Electron `safeStorage` and stored as `<dir>/.dek`
 *    (0600). The DEK never leaves this module unwrapped.
 *  - Reads auto-detect the envelope: legacy plaintext files load as before
 *    and are transparently migrated to encrypted form on the next save.
 *  - When the keychain is unavailable (tests, headless Linux without a
 *    keyring), files stay plaintext — identical to today's behavior, logged
 *    once. Plaintext is the documented fallback, not a silent regression.
 *
 * Out of scope on purpose: the memory-files SQLite DB (needs SQLCipher, a
 * native-module change) and the codegraph cache (symbol names only).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { safeStorage } from 'electron';
import { logWarn, logError } from '../utils/logger';

const ENVELOPE_MARKER = 'cowork-aes-256-gcm-v1';
const DEK_FILE_NAME = '.dek';
const DEK_BYTES = 32;
const IV_BYTES = 12;

/** Wraps/unwraps the DEK. The OS keychain in prod, a test double in tests. */
export interface KeyProtector {
  protect(plain: Buffer): Buffer;
  unprotect(sealed: Buffer): Buffer;
}

let testProtector: KeyProtector | null | undefined;

/** Test hook: force (or disable) the protector regardless of environment. */
export function __setKeyProtectorForTest(protector: KeyProtector | null | undefined): void {
  testProtector = protector;
}

function osKeyProtector(): KeyProtector | null {
  try {
    if (
      typeof safeStorage === 'object' &&
      safeStorage !== null &&
      typeof safeStorage.isEncryptionAvailable === 'function' &&
      safeStorage.isEncryptionAvailable() &&
      typeof safeStorage.encryptString === 'function' &&
      typeof safeStorage.decryptString === 'function'
    ) {
      return {
        protect: (plain: Buffer) => safeStorage.encryptString(plain.toString('base64')),
        unprotect: (sealed: Buffer) =>
          Buffer.from(safeStorage.decryptString(sealed), 'base64'),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function activeProtector(): KeyProtector | null {
  return testProtector !== undefined ? testProtector : osKeyProtector();
}

function dekPath(dir: string): string {
  return path.join(dir, DEK_FILE_NAME);
}

/** Load the directory DEK, creating and persisting one on first use. */
export function loadOrCreateDek(dir: string, protector: KeyProtector): Buffer | null {
  try {
    const sealed = fs.readFileSync(dekPath(dir));
    const dek = protector.unprotect(Buffer.from(sealed.toString('utf8'), 'base64'));
    if (dek.length !== DEK_BYTES) {
      logError('[MemoryCrypto] Stored DEK has wrong length, refusing to use it.');
      return null;
    }
    return dek;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logError('[MemoryCrypto] Could not unwrap the DEK:', error);
      return null;
    }
  }
  try {
    const dek = crypto.randomBytes(DEK_BYTES);
    const sealed = protector.protect(dek).toString('base64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dekPath(dir), sealed, { encoding: 'utf8', mode: 0o600 });
    return dek;
  } catch (error) {
    logError('[MemoryCrypto] Could not persist a new DEK:', error);
    return null;
  }
}

interface Envelope {
  enc: string;
  iv: string;
  data: string;
}

/** Envelope a JSON value under a raw DEK (pure, no I/O — directly testable). */
export function encryptJson(data: unknown, dek: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: Envelope = {
    enc: ENVELOPE_MARKER,
    iv: iv.toString('base64'),
    data: Buffer.concat([ciphertext, tag]).toString('base64'),
  };
  return JSON.stringify(envelope);
}

/** Open an envelope produced by `encryptJson`. Throws on tamper/version skew. */
export function decryptJson<T>(envelopeRaw: string, dek: Buffer): T {
  const envelope = JSON.parse(envelopeRaw) as Partial<Envelope>;
  if (envelope.enc !== ENVELOPE_MARKER || !envelope.iv || !envelope.data) {
    throw new Error('Not a Cowork encrypted envelope.');
  }
  const iv = Buffer.from(envelope.iv, 'base64');
  const combined = Buffer.from(envelope.data, 'base64');
  if (iv.length !== IV_BYTES || combined.length < 16) {
    throw new Error('Malformed encrypted envelope.');
  }
  const ciphertext = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

/** True when the file text is one of our envelopes (cheap shape check). */
export function isEncryptedEnvelope(raw: string): boolean {
  if (!raw.includes(ENVELOPE_MARKER)) return false;
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope>;
    return parsed.enc === ENVELOPE_MARKER;
  } catch {
    return false;
  }
}

let fallbackWarned = false;

/**
 * Drop-in replacement for `saveJsonFile` for memory stores: encrypted when a
 * protector exists, plaintext otherwise (logged once per process).
 */
export function saveSecureJsonFile(filePath: string, data: unknown): void {
  const raw = JSON.stringify(data, null, 2);
  const protector = activeProtector();
  let payload = raw;
  if (protector) {
    const dek = loadOrCreateDek(path.dirname(filePath), protector);
    if (dek) {
      payload = encryptJson(data, dek);
    } else if (!fallbackWarned) {
      fallbackWarned = true;
      logWarn('[MemoryCrypto] DEK unavailable, storing memory file in plaintext.');
    }
  } else if (!fallbackWarned) {
    fallbackWarned = true;
    logWarn('[MemoryCrypto] No keychain protector, storing memory files in plaintext.');
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Drop-in replacement for `loadJsonFile` for memory stores. Encrypted files
 * require the protector + DEK; on any key failure the default is returned
 * ( loudly logged) rather than crashing the caller. Legacy plaintext files
 * load normally and migrate to encrypted form on their next save.
 */
export function loadSecureJsonFile<T>(filePath: string, defaultValue: T): T {
  let raw: string;
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return defaultValue;
  } catch {
    return defaultValue;
  }
  if (!isEncryptedEnvelope(raw)) {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
  }
  const protector = activeProtector();
  if (!protector) {
    logError('[MemoryCrypto] Encrypted memory file without an available keychain; returning default.');
    return defaultValue;
  }
  try {
    const dek = loadOrCreateDek(path.dirname(filePath), protector);
    if (!dek) {
      logError('[MemoryCrypto] DEK unavailable; returning default for encrypted file.');
      return defaultValue;
    }
    return decryptJson<T>(raw, dek);
  } catch (error) {
    logError('[MemoryCrypto] Failed to decrypt memory file (tamper or key mismatch); returning default:', error);
    return defaultValue;
  }
}

export function __resetMemoryCryptoForTest(): void {
  testProtector = undefined;
  fallbackWarned = false;
}
