/**
 * Real end-to-end check of the remote gateway, outside the vitest harness.
 *
 * Everything here is deliberately awkward to fake: a real certificate on disk,
 * a real listener bound to 0.0.0.0, and requests made over this machine's
 * routable LAN address rather than loopback. If the bind or the TLS were only
 * nominal, these checks would fail.
 *
 * Usage: npx vite-node scripts/verify-remote-e2e.ts   (or via tsx)
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpsRequest } from 'node:https';
import { WebSocket } from 'ws';
import { RemoteGateway } from '../src/main/remote/gateway';

const LAN_IP = process.env.VERIFY_LAN_IP ?? '127.0.0.1';
const STRONG = 'verify-token-'.padEnd(40, 'x');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function get(
  port: number,
  requestPath: string,
  token?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: LAN_IP,
        port,
        path: requestPath,
        rejectUnauthorized: false,
        timeout: 8000,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cowork-verify-'));
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=localhost',
    ],
    { stdio: 'ignore' }
  );

  console.log(`\nTarget address: ${LAN_IP}\n`);

  const router = {
    onResponse: () => undefined,
    getActiveSessionCount: () => 0,
    routeMessage: async () => undefined,
  } as never;

  // --- 1. TLS on a routable bind, with a token ------------------------------
  console.log('1. TLS on a routable bind (0.0.0.0)');
  const gateway = new RemoteGateway(
    {
      enabled: true,
      port: 0,
      bind: '0.0.0.0',
      tls: { enabled: true, certPath, keyPath },
      auth: { mode: 'token', token: STRONG },
    },
    router
  );
  await gateway.start();
  const server = (gateway as unknown as { httpServer: { address(): { port: number } } }).httpServer;
  const port = server.address().port;
  console.log(`   listening on 0.0.0.0:${port}\n`);

  const health = await get(port, '/health');
  check('HTTPS /health answers over the LAN address', health.status === 200, `status ${health.status}`);

  const anonymous = await get(port, '/status');
  check('/status refuses anonymous callers', anonymous.status === 401, `status ${anonymous.status}`);

  const wrong = await get(port, '/status', 'wrong-token');
  check('/status refuses a wrong token', wrong.status === 401, `status ${wrong.status}`);

  const authorized = await get(port, '/status', STRONG);
  check('/status accepts the control token', authorized.status === 200, `status ${authorized.status}`);

  const ws = new WebSocket(`wss://${LAN_IP}:${port}/ws`, { rejectUnauthorized: false });
  const wsOk = await new Promise<boolean>((resolve) => {
    ws.once('open', () => resolve(true));
    ws.once('error', () => resolve(false));
  });
  check('WSS handshake succeeds', wsOk);
  ws.close();

  await gateway.stop();

  // --- 2. Fail closed ------------------------------------------------------
  console.log('\n2. Fail-closed behaviour');
  const bad = new RemoteGateway(
    {
      enabled: true,
      port: 0,
      bind: '0.0.0.0',
      tls: { enabled: true, certPath: '/nonexistent/cert.pem', keyPath },
      auth: { mode: 'token', token: STRONG },
    },
    router
  );
  let refused = false;
  try {
    await bad.start();
  } catch {
    refused = true;
  }
  check('unreadable certificate aborts startup', refused && !bad.running);

  const noToken = new RemoteGateway(
    { enabled: true, port: 0, bind: '0.0.0.0', auth: { mode: 'open' } },
    router
  );
  let refusedNoToken = false;
  try {
    await noToken.start();
  } catch {
    refusedNoToken = true;
  }
  check('routable bind without a token aborts startup', refusedNoToken && !noToken.running);

  const unacknowledged = new RemoteGateway(
    { enabled: true, port: 0, bind: '0.0.0.0', auth: { mode: 'token', token: STRONG } },
    router
  );
  let refusedPlain = false;
  try {
    await unacknowledged.start();
  } catch {
    refusedPlain = true;
  }
  check('plaintext LAN without acknowledgement aborts startup', refusedPlain && !unacknowledged.running);

  rmSync(dir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('verification crashed:', error);
  process.exit(1);
});