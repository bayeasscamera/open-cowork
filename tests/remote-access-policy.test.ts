import { describe, expect, it } from 'vitest';
import {
  MIN_REMOTE_CONTROL_TOKEN_LENGTH,
  RemoteNetworkAccessError,
  assertSafeRemoteExposure,
  getRemoteNetworkExposure,
} from '../src/main/remote/remote-access-policy';
import {
  classifyRemoteTransport,
  isTransportEncrypted,
  isTransportOffHost,
  requiresInsecureBindingAcknowledgement,
} from '../src/shared/remote-transport';
import type { GatewayConfig } from '../src/main/remote/types';

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    enabled: true,
    port: 18789,
    bind: '127.0.0.1',
    auth: { mode: 'allowlist', allowlist: [] },
    ...overrides,
  };
}

describe('remote network exposure policy', () => {
  it('treats a loopback listener with a disabled tunnel as local', () => {
    expect(getRemoteNetworkExposure(config())).toBe('loopback');
  });

  it.each([
    ['a non-loopback listener', { bind: '0.0.0.0' as const }],
    ['an enabled tunnel to a loopback listener', { tunnel: { enabled: true, type: 'ngrok' as const } }],
  ])('treats %s as remote', (_label, overrides) => {
    expect(getRemoteNetworkExposure(config(overrides))).toBe('remote');
  });

  it('allows loopback access without a remote-control token', () => {
    expect(() => assertSafeRemoteExposure(config())).not.toThrow();
  });

  it('refuses unauthenticated remote access before the listener starts', () => {
    expect(() =>
      assertSafeRemoteExposure(config({ bind: '0.0.0.0', auth: { mode: 'open' } }))
    ).toThrow(/remote control token is required/i);
  });

  it('refuses remote access when only a short token is configured', () => {
    expect(() =>
      assertSafeRemoteExposure(
        config({
          bind: '0.0.0.0',
          auth: { mode: 'token', token: 'short' },
        })
      )
    ).toThrow(/at least \d+ characters/i);
  });

  it('accepts a dedicated remote-control token outside token mode', () => {
    const token = 'r'.repeat(MIN_REMOTE_CONTROL_TOKEN_LENGTH);
    expect(() =>
      assertSafeRemoteExposure(
        config({
          bind: '0.0.0.0',
          tunnel: { enabled: true, type: 'ngrok' },
          auth: { mode: 'allowlist', allowlist: ['feishu:user-1'], remoteControlToken: token },
        })
      )
    ).not.toThrow();
  });

  it('accepts a sufficiently long legacy token-mode credential', () => {
    const token = 't'.repeat(MIN_REMOTE_CONTROL_TOKEN_LENGTH);
    expect(() =>
      assertSafeRemoteExposure(
        config({
          bind: '0.0.0.0',
          // Satisfies the transport gate so the credential stays the only
          // variable under test here; that gate has its own cases below.
          allowInsecureRemoteBinding: true,
          auth: { mode: 'token', token },
        })
      )
    ).not.toThrow();
  });
});

describe('unencrypted LAN binding barrier', () => {
  const STRONG = 'a'.repeat(40);

  it('refuses a routable bind with no tunnel, even with a strong token', () => {
    expect(() =>
      assertSafeRemoteExposure(config({ bind: '0.0.0.0', auth: { mode: 'token', token: STRONG } }))
    ).toThrow(RemoteNetworkAccessError);

    try {
      assertSafeRemoteExposure(
        config({ bind: '0.0.0.0', auth: { mode: 'token', token: STRONG } })
      );
    } catch (error) {
      expect((error as RemoteNetworkAccessError).code).toBe('unencrypted-remote-binding');
    }
  });

  it('accepts a routable bind once the unencrypted network is acknowledged', () => {
    expect(() =>
      assertSafeRemoteExposure(
        config({
          bind: '0.0.0.0',
          allowInsecureRemoteBinding: true,
          auth: { mode: 'token', token: STRONG },
        })
      )
    ).not.toThrow();
  });

  it('does not require the acknowledgement when a tunnel terminates TLS', () => {
    expect(() =>
      assertSafeRemoteExposure(
        config({
          bind: '0.0.0.0',
          tunnel: { enabled: true, type: 'ngrok' },
          auth: { mode: 'token', token: STRONG },
        })
      )
    ).not.toThrow();
  });

  it('never asks for the acknowledgement on loopback', () => {
    expect(() => assertSafeRemoteExposure(config())).not.toThrow();
    expect(() => assertSafeRemoteExposure(config({ tunnel: { enabled: true, type: 'ngrok' } }))).toThrow(
      RemoteNetworkAccessError
    );
  });

  it('still demands a token before it considers the acknowledgement', () => {
    // Acknowledging plaintext must not become a way to skip authentication.
    expect(() =>
      assertSafeRemoteExposure(config({ bind: '0.0.0.0', allowInsecureRemoteBinding: true }))
    ).toThrow(/remote control token is required/i);
  });
});

describe('transport classification', () => {
  it('reports how the gateway is reachable and whether it is encrypted', () => {
    expect(classifyRemoteTransport({ bind: '127.0.0.1' })).toBe('loopback');
    expect(classifyRemoteTransport({ bind: '0.0.0.0' })).toBe('plaintext-lan');
    expect(classifyRemoteTransport({ bind: '127.0.0.1', tunnelEnabled: true })).toBe('tunnel-tls');
    // A tunnel wins: the public leg is TLS whatever the local bind says.
    expect(classifyRemoteTransport({ bind: '0.0.0.0', tunnelEnabled: true })).toBe('tunnel-tls');
  });

  it('treats a missing bind as loopback rather than as exposure', () => {
    expect(classifyRemoteTransport({})).toBe('loopback');
    expect(isTransportEncrypted(classifyRemoteTransport({}))).toBe(true);
    expect(isTransportOffHost(classifyRemoteTransport({}))).toBe(false);
  });

  it('marks only the plaintext LAN leg as unencrypted and off-host', () => {
    expect(isTransportEncrypted('tunnel-tls')).toBe(true);
    expect(isTransportEncrypted('plaintext-lan')).toBe(false);
    expect(requiresInsecureBindingAcknowledgement('plaintext-lan')).toBe(true);
    expect(requiresInsecureBindingAcknowledgement('tunnel-tls')).toBe(false);
    expect(requiresInsecureBindingAcknowledgement('loopback')).toBe(false);
  });
});
