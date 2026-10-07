/**
 * Feishu (飞书) event payload crypto.
 *
 * Feishu fixes both the cipher and the signature scheme on its side, so these
 * live as pure functions with no channel state. That keeps them unit-testable
 * against the worked examples published alongside the specification — the only
 * way to know the implementation is not merely self-consistent.
 */

import * as crypto from 'crypto';

/** AES block size, and therefore the length of the IV Feishu prepends. */
const AES_BLOCK_SIZE = 16;

/** A SHA-256 digest, as hex. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * Compare two hex digests in constant time.
 *
 * Rejects anything that is not a 64-character hex digest first: `Buffer.from`
 * silently truncates invalid hex, so a short or malformed header could
 * otherwise decode to a buffer that happens to match.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (!SHA256_HEX.test(a) || !SHA256_HEX.test(b)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Signature of a webhook whose body was encrypted with the Encrypt Key.
 *
 * This is a plain SHA-256 over `timestamp + nonce + encrypt_key + body` — not
 * an HMAC. Feishu concatenates the Encrypt Key rather than using it as a MAC
 * key, so an HMAC computed with the same secret can never match. The body must
 * be the raw request body: signing a re-serialized object will not work.
 */
export function computeEventSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  body: string
): string {
  return crypto
    .createHash('sha256')
    .update(timestamp + nonce + encryptKey + body)
    .digest('hex');
}

/**
 * Decrypt an event payload encrypted with the Encrypt Key.
 *
 * The scheme is fixed by Feishu and not configurable: the AES-256 key is the
 * raw SHA-256 of the Encrypt Key, the first 16 bytes of the base64-decoded
 * payload are the IV, and the remainder is AES-256-CBC with PKCS#7 padding.
 *
 * Pinned by the example published with the spec — `decryptEventPayload('test
 * key', 'P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=')` returns `hello world`.
 */
export function decryptEventPayload(encryptKey: string, encrypted: string): string {
  const key = crypto.createHash('sha256').update(encryptKey, 'utf8').digest();
  const payload = Buffer.from(encrypted, 'base64');

  if (payload.length <= AES_BLOCK_SIZE) {
    throw new Error('Encrypted payload is too short to contain an IV and ciphertext');
  }

  const iv = payload.subarray(0, AES_BLOCK_SIZE);
  const ciphertext = payload.subarray(AES_BLOCK_SIZE);
  if (ciphertext.length % AES_BLOCK_SIZE !== 0) {
    throw new Error('Encrypted payload is not a whole number of AES blocks');
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
