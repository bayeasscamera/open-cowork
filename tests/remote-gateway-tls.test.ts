import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { WebSocket } from 'ws';
import { RemoteGateway } from '../src/main/remote/gateway';
import type { GatewayConfig } from '../src/main/remote/types';

/**
 * These tests exercise real TLS: a certificate is generated on the fly, the
 * gateway is started with it, and an actual HTTPS request and WebSocket
 * handshake are performed. Asserting on config plumbing alone would not catch a
 * listener that silently serves plaintext.
 *
 * Skipped when openssl is unavailable, because generating the fixture is the
 * only reason it is needed.
 */
let dir: string;
let certPath: string;
let keyPath: string;
let hasOpenssl = true;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cowork-tls-'));
  certPath = path.join(dir, 'cert.pem');
  keyPath = path.join(dir, 'key.pem');
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', '2', '-subj', '/CN=localhost',
      ],
      { stdio: 'ignore' }
    );
  } catch {
    hasOpenssl = false;
  }
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const STRONG = 't'.repeat(40);

function router() {
  return {
    onResponse: () => undefined,
    getActiveSessionCount: () => 0,
    routeMessage: async () => undefined,
  } as never;
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    enabled: true,
    port: 0,
    bind: '0.0.0.0',
    tls: { enabled: true, certPath, keyPath },
    auth: { mode: 'token', token: STRONG },
    ...overrides,
  };
}

function boundPort(gateway: RemoteGateway): number {
  const server = (gateway as unknown as { httpServer?: { address?: () => unknown } }).httpServer;
  const address = server?.address?.();
  if (!address || typeof address === 'string') {
    throw new Error('gateway is not bound to a TCP port');
  }
  return (address as { port: number }).port;
}

/** HTTPS GET that accepts the throwaway self-signed certificate. */
function httpsGet(port: number, requestPath: string): Promise<{ status: number; body: string }> {
  return get(httpsRequest, port, requestPath);
}

/** Plaintext HTTP GET, used to prove a listener is genuinely not TLS. */
function httpGet(port: number, requestPath: string): Promise<{ status: number; body: string }> {
  return get(httpRequest, port, requestPath);
}

function get(
  makeRequest: typeof httpsRequest,
  port: number,
  requestPath: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = makeRequest(
      { host: '127.0.0.1', port, path: requestPath, rejectUnauthorized: false, timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

describe('RemoteGateway TLS', () => {
  it('serves HTTPS when a certificate is configured', async () => {
    if (!hasOpenssl) return;
    const gateway = new RemoteGateway(makeConfig(), router());
    try {
      await gateway.start();
      const res = await httpsGet(boundPort(gateway), '/health');
      expect(res.status).toBe(200);
    } finally {
      await gateway.stop();
    }
  });

  it('serves WSS over the same listener, since the socket is already TLS', async () => {
    if (!hasOpenssl) return;
    const gateway = new RemoteGateway(makeConfig(), router());
    try {
      await gateway.start();
      const port = boundPort(gateway);
      const client = new WebSocket(`wss://127.0.0.1:${port}/ws`, {
        rejectUnauthorized: false,
      });
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });
      expect(client.readyState).toBe(WebSocket.OPEN);
      client.close();
    } finally {
      await gateway.stop();
    }
  });

  it('refuses to start rather than falling back to plaintext on an unreadable certificate', async () => {
    const gateway = new RemoteGateway(
      makeConfig({ tls: { enabled: true, certPath: '/nonexistent/cert.pem', keyPath } }),
      router()
    );
    await expect(gateway.start()).rejects.toThrow(/certificate could not be read/i);
    expect(gateway.running).toBe(false);
  });

  it('refuses to start rather than falling back to plaintext on an unreadable key', async () => {
    const gateway = new RemoteGateway(
      makeConfig({ tls: { enabled: true, certPath, keyPath: '/nonexistent/key.pem' } }),
      router()
    );
    await expect(gateway.start()).rejects.toThrow(/private key could not be read/i);
    expect(gateway.running).toBe(false);
  });

  it('needs no plaintext acknowledgement once a certificate is configured', async () => {
    if (!hasOpenssl) return;
    // The whole point of TLS: the bind is routable and encrypted, so the
    // insecure-binding acknowledgement must not be demanded.
    const gateway = new RemoteGateway(makeConfig({ allowInsecureRemoteBinding: false }), router());
    await gateway.start();
    expect(gateway.running).toBe(true);
    await gateway.stop();
  });

  it('still demands a plaintext acknowledgement without a certificate', async () => {
    const gateway = new RemoteGateway(
      makeConfig({ tls: undefined, allowInsecureRemoteBinding: false }),
      router()
    );
    await expect(gateway.start()).rejects.toThrow(/unencrypted/i);
  });

  it('rejects TLS enabled without both paths before touching the filesystem', async () => {
    const gateway = new RemoteGateway(
      makeConfig({ tls: { enabled: true, certPath: '', keyPath } }),
      router()
    );
    await expect(gateway.start()).rejects.toThrow(/certPath/i);
  });

  it('keeps serving plain HTTP when TLS is not configured', async () => {
    const gateway = new RemoteGateway(
      makeConfig({
        bind: '127.0.0.1',
        tls: undefined,
        allowInsecureRemoteBinding: true,
      }),
      router()
    );
    try {
      await gateway.start();
      // A plaintext listener answers this. That is what makes the contrast
      // meaningful: the HTTPS probe in the first test only succeeds when TLS is
      // actually configured, so neither case can pass by accident.
      const res = await httpGet(boundPort(gateway), '/health');
      expect(res.status).toBe(200);
    } finally {
      await gateway.stop();
    }
  });
});