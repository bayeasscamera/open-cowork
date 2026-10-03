import { describe, expect, it } from 'vitest';
import {
  MIN_REMOTE_CONTROL_TOKEN_LENGTH,
  assertSafeRemoteExposure,
  getRemoteNetworkExposure,
} from '../src/main/remote/remote-access-policy';
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
      assertSafeRemoteExposure(config({ bind: '0.0.0.0', auth: { mode: 'token', token } }))
    ).not.toThrow();
  });
});
