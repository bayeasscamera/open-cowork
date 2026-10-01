/**
 * Encryption at rest for memory JSON files (AES-256-GCM, OS-keychain-wrapped
 * DEK). Proofs: round-trip, tamper rejection, legacy plaintext migration,
 * no-keychain fallback, and end-to-end secrecy through a real store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  __resetMemoryCryptoForTest,
  __setKeyProtectorForTest,
  decryptJson,
  encryptJson,
  isEncryptedEnvelope,
  loadOrCreateDek,
  loadSecureJsonFile,
  saveSecureJsonFile,
  type KeyProtector,
} from '../src/main/memory/memory-file-crypto';
import { CoreMemoryStore } from '../src/main/memory/core-memory-store';

/** XOR toy protector: proves plumbing, never used in prod. */
const xorProtector: KeyProtector = {
  protect: (plain: Buffer) => Buffer.from(plain.map((b) => b ^ 0x5a)),
  unprotect: (sealed: Buffer) => Buffer.from(sealed.map((b) => b ^ 0x5a)),
};

beforeEach(() => {
  __resetMemoryCryptoForTest();
});

afterEach(() => {
  __resetMemoryCryptoForTest();
});

describe('envelope', () => {
  it('round-trips arbitrary JSON under a raw DEK', () => {
    const dek = randomBytes(32);
    const data = { sessions: [{ id: 'a', text: 'héllo wörld' }], n: 3 };
    expect(decryptJson<typeof data>(encryptJson(data, dek), dek)).toEqual(data);
  });

  it('uses a fresh IV per write (no two ciphertexts alike)', () => {
    const dek = randomBytes(32);
    expect(encryptJson({ a: 1 }, dek)).not.toBe(encryptJson({ a: 1 }, dek));
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    const dek = randomBytes(32);
    const envelope = JSON.parse(encryptJson({ secret: 1 }, dek)) as {
      data: string;
    };
    const bytes = Buffer.from(envelope.data, 'base64');
    bytes[0] ^= 0xff;
    envelope.data = bytes.toString('base64');
    expect(() => decryptJson(JSON.stringify(envelope), dek)).toThrow();
    expect(() => decryptJson(encryptJson({ secret: 1 }, dek), randomBytes(32))).toThrow();
  });

  it('detects envelopes and ignores plaintext', () => {
    const dek = randomBytes(32);
    expect(isEncryptedEnvelope(encryptJson({ a: 1 }, dek))).toBe(true);
    expect(isEncryptedEnvelope('{"sessions": []}')).toBe(false);
    expect(isEncryptedEnvelope('not json at all')).toBe(false);
  });
});

describe('DEK lifecycle', () => {
  it('creates, persists and reloads the same key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-dek-'));
    try {
      const first = loadOrCreateDek(dir, xorProtector);
      const second = loadOrCreateDek(dir, xorProtector);
      expect(first).not.toBeNull();
      expect(second?.equals(first!)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('secure files', () => {
  it('stores ciphertext on disk and reads it back with a protector', () => {
    __setKeyProtectorForTest(xorProtector);
    const dir = mkdtempSync(join(tmpdir(), 'memory-secure-'));
    try {
      const file = join(dir, 'core_memory.json');
      saveSecureJsonFile(file, { lang: 'gateway token rotation' });
      const raw = readFileSync(file, 'utf8');
      expect(raw).not.toContain('gateway token rotation');
      expect(isEncryptedEnvelope(raw)).toBe(true);
      expect(loadSecureJsonFile<Record<string, string>>(file, {})).toEqual({
        lang: 'gateway token rotation',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates legacy plaintext on the next save', () => {
    __setKeyProtectorForTest(xorProtector);
    const dir = mkdtempSync(join(tmpdir(), 'memory-migrate-'));
    try {
      const file = join(dir, 'core_memory.json');
      writeFileSync(file, JSON.stringify({ old: 'legacy plain data' }), 'utf8');
      // Legacy file still loads…
      expect(loadSecureJsonFile<Record<string, string>>(file, {})).toEqual({
        old: 'legacy plain data',
      });
      // …and the next save encrypts it.
      saveSecureJsonFile(file, { old: 'legacy plain data' });
      expect(isEncryptedEnvelope(readFileSync(file, 'utf8'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to plaintext without a keychain (documented, not silent)', () => {
    __setKeyProtectorForTest(null);
    const dir = mkdtempSync(join(tmpdir(), 'memory-plain-'));
    try {
      const file = join(dir, 's.json');
      saveSecureJsonFile(file, { a: 1 });
      expect(isEncryptedEnvelope(readFileSync(file, 'utf8'))).toBe(false);
      expect(loadSecureJsonFile(file, {})).toEqual({ a: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the default on corrupt envelopes instead of throwing', () => {
    __setKeyProtectorForTest(xorProtector);
    const dir = mkdtempSync(join(tmpdir(), 'memory-corrupt-'));
    try {
      const file = join(dir, 's.json');
      writeFileSync(
        file,
        JSON.stringify({ enc: 'cowork-aes-256-gcm-v1', iv: 'xx', data: 'yy' }),
        'utf8'
      );
      expect(loadSecureJsonFile(file, { fallback: true })).toEqual({ fallback: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('end-to-end through CoreMemoryStore', () => {
  it('no secret survives on disk in readable form', () => {
    __setKeyProtectorForTest(xorProtector);
    const dir = mkdtempSync(join(tmpdir(), 'memory-e2e-'));
    try {
      const file = join(dir, 'core_memory.json');
      const store = new CoreMemoryStore(file);
      store.applyActions([
        { op: 'upsert', category: 'preferences', key: 'deploy', value: 'rotate the gateway token nightly' },
      ]);
      const raw = readFileSync(file, 'utf8');
      expect(raw).not.toContain('gateway token');
      const reopened = new CoreMemoryStore(file);
      expect(reopened.getRaw()['preferences.deploy']).toBe('rotate the gateway token nightly');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
