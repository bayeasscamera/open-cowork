/**
 * Feishu channel webhook tests.
 *
 * Feishu fixes the cipher and the signature scheme on its side, so these tests
 * pin both against the worked example published with the specification, then
 * drive the whole webhook end to end through the public `handleWebhook`.
 */

import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { FeishuChannel } from '../src/main/remote/channels/feishu/feishu-channel';
import {
  computeEventSignature,
  decryptEventPayload,
  timingSafeEqualHex,
} from '../src/main/remote/channels/feishu/feishu-crypto';
import type { FeishuChannelConfig, RemoteMessage } from '../src/main/remote/types';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// The Encrypt Key used by the worked example in Feishu's own documentation.
const ENCRYPT_KEY = 'test key';
const TIMESTAMP = '1700000000';
const NONCE = 'nonce-1';

function makeChannel(overrides: Partial<FeishuChannelConfig> = {}): FeishuChannel {
  const config: FeishuChannelConfig = {
    type: 'feishu',
    appId: 'app-id',
    appSecret: 'app-secret',
    dm: { policy: 'open' },
    ...overrides,
  };
  return new FeishuChannel(config);
}

/** Encrypt a payload the way Feishu does: IV prepended, AES-256-CBC. */
function encryptBody(encryptKey: string, plaintext: string): string {
  const key = crypto.createHash('sha256').update(encryptKey, 'utf8').digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ciphertext]).toString('base64');
}

function encryptedEnvelope(encryptKey: string, plaintext: string): string {
  return JSON.stringify({ encrypt: encryptBody(encryptKey, plaintext) });
}

function headersFor(encryptKey: string, body: string, signature?: string) {
  return {
    'x-lark-signature': signature ?? computeEventSignature(TIMESTAMP, NONCE, encryptKey, body),
    'x-lark-request-timestamp': TIMESTAMP,
    'x-lark-request-nonce': NONCE,
  };
}

/** The legacy scheme: an HMAC keyed with the Verification Token. */
function legacySignature(verificationToken: string, body: string): string {
  return crypto
    .createHmac('sha256', verificationToken)
    .update(TIMESTAMP + NONCE + verificationToken + body)
    .digest('hex');
}

const MESSAGE_EVENT = {
  schema: '2.0',
  header: { event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      message_type: 'text',
      create_time: '1700000000000',
      content: JSON.stringify({ text: 'bonjour' }),
    },
  },
};

/** Attach a message handler and return the messages it receives. */
function collectMessages(channel: FeishuChannel): RemoteMessage[] {
  const received: RemoteMessage[] = [];
  channel.onMessage((message) => received.push(message));
  return received;
}

describe('decryptEventPayload', () => {
  it('matches the worked example published with the Feishu spec', () => {
    // This ciphertext and key come from Feishu's own decryption sample. It is
    // the only check here that proves the algorithm, rather than proving the
    // implementation agrees with itself.
    expect(decryptEventPayload(ENCRYPT_KEY, 'P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=')).toBe(
      'hello world'
    );
  });

  it('refuses a payload too short to hold an IV', () => {
    expect(() => decryptEventPayload(ENCRYPT_KEY, Buffer.alloc(16).toString('base64'))).toThrow(
      /too short/
    );
  });

  it('refuses a payload that is not a whole number of AES blocks', () => {
    const payload = Buffer.concat([crypto.randomBytes(16), crypto.randomBytes(7)]);
    expect(() => decryptEventPayload(ENCRYPT_KEY, payload.toString('base64'))).toThrow(
      /whole number of AES blocks/
    );
  });
});

describe('timingSafeEqualHex', () => {
  it('refuses anything that is not a 64-character hex digest', () => {
    expect(timingSafeEqualHex('abc', 'abc')).toBe(false);
    expect(timingSafeEqualHex('z'.repeat(64), 'z'.repeat(64))).toBe(false);
  });

  it('accepts equal digests regardless of case', () => {
    const digest = 'a'.repeat(64);
    expect(timingSafeEqualHex(digest, digest.toUpperCase())).toBe(true);
  });
});

describe('FeishuChannel webhook — encrypted events', () => {
  it('decrypts an encrypted event and emits the message', () => {
    const channel = makeChannel({ encryptKey: ENCRYPT_KEY });
    const received = collectMessages(channel);
    const body = encryptedEnvelope(ENCRYPT_KEY, JSON.stringify(MESSAGE_EVENT));

    const result = channel.handleWebhook(headersFor(ENCRYPT_KEY, body), body);

    expect(result.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].content.text).toBe('bonjour');
    expect(received[0].channelId).toBe('oc_chat');
  });

  it('answers the url_verification challenge from an encrypted payload', () => {
    const channel = makeChannel({ encryptKey: ENCRYPT_KEY });
    const plaintext = JSON.stringify({ type: 'url_verification', challenge: 'chal-1' });
    const body = encryptedEnvelope(ENCRYPT_KEY, plaintext);

    const result = channel.handleWebhook(headersFor(ENCRYPT_KEY, body), body);

    expect(result.status).toBe(200);
    expect(result.data.challenge).toBe('chal-1');
  });

  it('refuses a payload it cannot decrypt instead of acknowledging it', () => {
    const channel = makeChannel({ encryptKey: ENCRYPT_KEY });
    // Validly signed, but encrypted under a different key: a key mismatch must
    // not be reported as success, or Feishu would stop retrying.
    const body = encryptedEnvelope('a different key', JSON.stringify(MESSAGE_EVENT));

    const result = channel.handleWebhook(headersFor(ENCRYPT_KEY, body), body);

    expect(result.status).toBe(400);
    expect(result.data.error).toBe('Undecryptable payload');
  });
});

describe('FeishuChannel webhook — signature', () => {
  it('rejects a request with no signature header', () => {
    const channel = makeChannel({ encryptKey: ENCRYPT_KEY });
    expect(channel.handleWebhook({}, '{}').status).toBe(403);
  });

  it('rejects a tampered signature', () => {
    const channel = makeChannel({ encryptKey: ENCRYPT_KEY });
    const body = encryptedEnvelope(ENCRYPT_KEY, JSON.stringify(MESSAGE_EVENT));

    const result = channel.handleWebhook(headersFor(ENCRYPT_KEY, body, 'f'.repeat(64)), body);

    expect(result.status).toBe(403);
    expect(result.data.error).toBe('Invalid signature');
  });

  it('rejects a body altered after signing', () => {
    const channel = makeChannel({ encryptKey: ENCRYPT_KEY });
    const body = encryptedEnvelope(ENCRYPT_KEY, JSON.stringify(MESSAGE_EVENT));
    const headers = headersFor(ENCRYPT_KEY, body);

    const result = channel.handleWebhook(headers, body.replace('"encrypt"', '"encrypt "'));

    expect(result.status).toBe(403);
  });

  it('signs encrypted events with the encrypt key, not the verification token', () => {
    const channel = makeChannel({ encryptKey: ENCRYPT_KEY, verificationToken: 'verify-token' });
    const body = encryptedEnvelope(ENCRYPT_KEY, JSON.stringify(MESSAGE_EVENT));

    // Feishu's event signature is a plain SHA-256 over
    // timestamp + nonce + encrypt_key + body. An HMAC over the Verification
    // Token is what this channel used to compute, and it never matched.
    const result = channel.handleWebhook(
      headersFor(ENCRYPT_KEY, body, legacySignature('verify-token', body)),
      body
    );

    expect(result.status).toBe(403);
  });

  it('still accepts the legacy HMAC signature when only a verification token is set', () => {
    const channel = makeChannel({ verificationToken: 'verify-token' });
    const received = collectMessages(channel);
    const body = JSON.stringify(MESSAGE_EVENT);

    const result = channel.handleWebhook(
      headersFor('verify-token', body, legacySignature('verify-token', body)),
      body
    );

    expect(result.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it('reports an encrypted payload that arrives with no encrypt key configured', () => {
    const channel = makeChannel({ verificationToken: 'verify-token' });
    const body = encryptedEnvelope(ENCRYPT_KEY, JSON.stringify(MESSAGE_EVENT));

    const result = channel.handleWebhook(
      headersFor('verify-token', body, legacySignature('verify-token', body)),
      body
    );

    expect(result.status).toBe(400);
    expect(result.data.error).toBe('Encrypt Key not configured');
  });

  it('still accepts a plaintext event when no encrypt key is configured', () => {
    const channel = makeChannel({ verificationToken: 'verify-token' });
    const received = collectMessages(channel);
    const body = JSON.stringify(MESSAGE_EVENT);

    const result = channel.handleWebhook(
      headersFor('verify-token', body, legacySignature('verify-token', body)),
      body
    );

    expect(result.status).toBe(200);
    expect(received[0].content.text).toBe('bonjour');
  });
});
