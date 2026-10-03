import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  set: vi.fn((key: string, value: unknown) => {
    mocks.store.set(key, value);
  }),
  get: vi.fn((key: string) => mocks.store.get(key)),
}));

vi.mock('electron-store', () => ({
  default: class {
    get = mocks.get;
    set = mocks.set;
  },
}));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { remoteConfigStore } from '../src/main/remote/remote-config-store';
import { RemoteNetworkAccessError } from '../src/main/remote/remote-access-policy';

const STRONG = 't'.repeat(40);

describe('gateway config persistence honours the transport policy', () => {
  beforeEach(() => {
    mocks.store.clear();
    vi.clearAllMocks();
    mocks.store.set('gateway', {
      enabled: false,
      port: 18789,
      bind: '127.0.0.1',
      auth: { mode: 'allowlist', allowlist: [] },
    });
    mocks.store.set('channels', {});
  });

  it('refuses to persist TLS that is enabled without both paths', () => {
    // Validating only at start would leave the app unable to save settings, then
    // silently failing to boot on the next launch.
    expect(() =>
      remoteConfigStore.setGatewayConfig({ tls: { enabled: true, certPath: '', keyPath: '' } })
    ).toThrow(RemoteNetworkAccessError);

    expect(() =>
      remoteConfigStore.setGatewayConfig({
        tls: { enabled: true, certPath: '/tmp/cert.pem', keyPath: '   ' },
      })
    ).toThrow(/keyPath/i);
  });

  it('persists a complete TLS config', () => {
    remoteConfigStore.setGatewayConfig({
      tls: { enabled: true, certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' },
    });
    expect(mocks.store.get('gateway')).toMatchObject({
      tls: { enabled: true, certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' },
    });
  });

  it('refuses to persist an acknowledged-but-unencrypted remote bind without a token', () => {
    expect(() =>
      remoteConfigStore.setGatewayConfig({
        bind: '0.0.0.0',
        allowInsecureRemoteBinding: true,
      })
    ).toThrow(/remote control token is required/i);
  });

  it('persists an acknowledged plaintext bind once a strong token exists', () => {
    remoteConfigStore.setGatewayConfig({
      bind: '0.0.0.0',
      allowInsecureRemoteBinding: true,
      auth: { mode: 'token', token: STRONG },
    });
    expect(mocks.store.get('gateway')).toMatchObject({
      bind: '0.0.0.0',
      allowInsecureRemoteBinding: true,
    });
  });

  it('keeps an unrelated field change from dropping a provisioned token', () => {
    remoteConfigStore.setGatewayConfig({
      bind: '0.0.0.0',
      allowInsecureRemoteBinding: true,
      auth: { mode: 'token', token: STRONG },
    });
    remoteConfigStore.setGatewayConfig({ port: 19999 });
    const stored = mocks.store.get('gateway') as { port: number; auth: { token?: string } };
    expect(stored.port).toBe(19999);
    expect(stored.auth.token).toBe(STRONG);
  });
});