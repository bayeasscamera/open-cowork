/**
 * RemoteGateway characterization tests.
 *
 * Covers channel registration, authorization modes, the pairing flow, the HTTP
 * control endpoints (health/status/webhook) and the WebSocket control plane
 * (auth, rate limiting, message routing, broadcast).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';
import { RemoteGateway } from '../src/main/remote/gateway';
import { logError } from '../src/main/utils/logger';
import type {
  ChannelType,
  GatewayAuthConfig,
  GatewayConfig,
  IChannel,
  RemoteMessage,
  PairingRequest,
  PairedUser,
} from '../src/main/remote/types';
import type { MessageRouter } from '../src/main/remote/message-router';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type MessageHandler = (message: RemoteMessage) => void | Promise<void>;
type ErrorHandler = (error: Error) => void;

interface FakeChannel {
  type: ChannelType;
  connected: boolean;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  onMessage: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
}

function makeChannel(type: ChannelType = 'feishu'): FakeChannel {
  const channel: FakeChannel = {
    type,
    connected: false,
    start: vi.fn(async () => {
      channel.connected = true;
    }),
    stop: vi.fn(async () => {
      channel.connected = false;
    }),
    send: vi.fn(async () => undefined),
    onMessage: vi.fn(),
    onError: vi.fn(),
  };
  return channel;
}

function asChannel(channel: FakeChannel): IChannel {
  return channel as unknown as IChannel;
}

function messageHandlerOf(channel: FakeChannel): MessageHandler {
  const calls = channel.onMessage.mock.calls;
  if (calls.length === 0) throw new Error('channel.onMessage was never called');
  return calls[0][0] as MessageHandler;
}

function errorHandlerOf(channel: FakeChannel): ErrorHandler {
  const calls = channel.onError.mock.calls;
  if (calls.length === 0) throw new Error('channel.onError was never called');
  return calls[0][0] as ErrorHandler;
}

function makeConfig(auth: GatewayAuthConfig, extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return { enabled: true, port: 0, bind: '127.0.0.1', auth, ...extra };
}

function makeMessage(overrides: Partial<RemoteMessage> = {}): RemoteMessage {
  return {
    id: 'msg-1',
    channelType: 'feishu',
    channelId: 'chat-1',
    sender: { id: 'user-1', name: 'Alice', isBot: false },
    content: { type: 'text', text: 'hello' },
    timestamp: Date.now(),
    isGroup: false,
    isMentioned: false,
    ...overrides,
  };
}

interface GatewayInternals {
  pairingRequests: Map<string, PairingRequest>;
  pairedUsers: Map<string, PairedUser>;
  wsClients: Map<string, { authenticated: boolean; ip: string }>;
  authAttempts: Map<string, { count: number; resetTime: number }>;
  lastAuthAttemptPurge: number;
  httpServer?: { address(): { port: number } | string | null };
}

function internals(gateway: RemoteGateway): GatewayInternals {
  return gateway as unknown as GatewayInternals;
}

/** Reserve then release an ephemeral TCP port for tests that need a known one. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('no ephemeral port available'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function boundPort(gateway: RemoteGateway): number {
  const address = internals(gateway).httpServer?.address();
  if (!address || typeof address === 'string') {
    throw new Error('HTTP server is not bound to a TCP port');
  }
  return address.port;
}

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

interface HttpResponse {
  status: number;
  body: string;
}

function httpRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

interface WsEnvelope {
  type: string;
  payload: unknown;
  requestId?: string;
}

class WsProbe {
  private readonly ws: WebSocket;
  private readonly received: WsEnvelope[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data: Buffer) => {
      this.received.push(JSON.parse(data.toString()) as WsEnvelope);
    });
  }

  static connect(port: number): Promise<WsProbe> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
      const probe = new WsProbe(ws);
      ws.on('open', () => resolve(probe));
      ws.on('error', reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  all(): WsEnvelope[] {
    return this.received;
  }

  async next(type: string, occurrence = 1, timeoutMs = 3000): Promise<WsEnvelope> {
    const start = Date.now();
    for (;;) {
      const matches = this.received.filter((entry) => entry.type === type);
      if (matches.length >= occurrence) return matches[occurrence - 1];
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          'timed out waiting for ' +
            type +
            '; received: ' +
            this.received.map((e) => e.type).join(',')
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  close(): void {
    this.ws.close();
  }
}

interface Harness {
  gateway: RemoteGateway;
  router: {
    onResponse: ReturnType<typeof vi.fn>;
    getActiveSessionCount: ReturnType<typeof vi.fn>;
    routeMessage: ReturnType<typeof vi.fn>;
  };
}

function makeGateway(auth: GatewayAuthConfig, extra: Partial<GatewayConfig> = {}): Harness {
  const router = {
    onResponse: vi.fn(),
    getActiveSessionCount: vi.fn(() => 3),
    routeMessage: vi.fn(async () => undefined),
  };
  const gateway = new RemoteGateway(makeConfig(auth, extra), router as unknown as MessageRouter);
  return { gateway, router };
}

let running: RemoteGateway[] = [];
let probes: WsProbe[] = [];

function tracked(harness: Harness): Harness {
  running.push(harness.gateway);
  return harness;
}

beforeEach(() => {
  running = [];
  probes = [];
});

afterEach(async () => {
  for (const probe of probes) {
    try {
      probe.close();
    } catch {
      // ignore
    }
  }
  for (const gateway of running) {
    try {
      await gateway.stop();
    } catch {
      // ignore
    }
  }
});

// ---------------------------------------------------------------------------
// Lifecycle and channel registry
// ---------------------------------------------------------------------------

describe('RemoteGateway lifecycle', () => {
  it('starts in a stopped state', () => {
    const { gateway } = tracked(makeGateway({ mode: 'open' }));
    expect(gateway.running).toBe(false);
    expect(gateway.getStatus()).toEqual({
      running: false,
      port: undefined,
      publicUrl: undefined,
      channels: [],
      activeSessions: 3,
      pendingPairings: 0,
    });
  });

  it('subscribes to router responses on construction', () => {
    const { router } = makeGateway({ mode: 'open' });
    expect(router.onResponse).toHaveBeenCalledTimes(1);
    expect(typeof router.onResponse.mock.calls[0][0]).toBe('function');
  });

  it('registers a channel and wires its handlers', () => {
    const { gateway } = tracked(makeGateway({ mode: 'open' }));
    const channel = makeChannel('telegram');

    gateway.registerChannel(asChannel(channel));

    expect(channel.onMessage).toHaveBeenCalledTimes(1);
    expect(channel.onError).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().channels).toEqual([{ type: 'telegram', connected: false }]);
  });

  it('replaces a channel registered twice', () => {
    const { gateway } = tracked(makeGateway({ mode: 'open' }));
    const first = makeChannel('feishu');
    const second = makeChannel('feishu');

    gateway.registerChannel(asChannel(first));
    gateway.registerChannel(asChannel(second));

    expect(gateway.getStatus().channels).toHaveLength(1);
    expect(second.onMessage).toHaveBeenCalledTimes(1);
  });

  it('reports channel errors as gateway events', () => {
    const { gateway } = tracked(makeGateway({ mode: 'open' }));
    const channel = makeChannel('slack');
    const onError = vi.fn();
    gateway.on('channel.error', onError);

    gateway.registerChannel(asChannel(channel));
    errorHandlerOf(channel)(new Error('boom'));

    expect(onError).toHaveBeenCalledWith({ channel: 'slack', error: 'boom' });
  });

  it('unregisters a channel by stopping then dropping it', async () => {
    const { gateway } = tracked(makeGateway({ mode: 'open' }));
    const channel = makeChannel('feishu');
    gateway.registerChannel(asChannel(channel));

    await gateway.unregisterChannel('feishu');

    expect(channel.stop).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus().channels).toEqual([]);
  });

  it('ignores unregistering an unknown channel', async () => {
    const { gateway } = tracked(makeGateway({ mode: 'open' }));
    await expect(gateway.unregisterChannel('dingtalk')).resolves.toBeUndefined();
  });

  it('starts registered channels and flips running', async () => {
    const port = await freePort();
    const harness = tracked(makeGateway({ mode: 'open' }, { port }));
    const channel = makeChannel('feishu');
    harness.gateway.registerChannel(asChannel(channel));

    await harness.gateway.start();

    expect(harness.gateway.running).toBe(true);
    expect(channel.start).toHaveBeenCalledTimes(1);
    expect(boundPort(harness.gateway)).toBe(port);
    expect(harness.gateway.getStatus().port).toBe(port);
  });

  it('emits started and stopped events', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    const events: string[] = [];
    harness.gateway.on('event', (event: { type: string }) => events.push(event.type));

    await harness.gateway.start();
    await harness.gateway.stop();

    expect(events).toContain('gateway.started');
    expect(events).toContain('gateway.stopped');
  });

  it('is idempotent when started twice', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    await harness.gateway.start();
    await expect(harness.gateway.start()).resolves.toBeUndefined();
    expect(harness.gateway.running).toBe(true);
  });

  it('logs but survives a channel that fails to start while running', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    await harness.gateway.start();
    const channel = makeChannel('feishu');
    channel.start.mockRejectedValue(new Error('boot failed'));

    harness.gateway.registerChannel(asChannel(channel));

    await waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to start channel feishu'),
        expect.anything()
      )
    );
    expect(harness.gateway.running).toBe(true);
  });

  it('starts channels added while already running', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    await harness.gateway.start();
    const channel = makeChannel('wechat');

    harness.gateway.registerChannel(asChannel(channel));

    await waitFor(() => expect(channel.start).toHaveBeenCalledTimes(1));
  });

  it('survives a channel that fails to start', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    const channel = makeChannel('feishu');
    channel.start.mockRejectedValue(new Error('nope'));
    harness.gateway.registerChannel(asChannel(channel));

    await expect(harness.gateway.start()).resolves.toBeUndefined();
    expect(harness.gateway.running).toBe(true);
  });

  it('survives a channel that fails to stop', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    const channel = makeChannel('feishu');
    channel.stop.mockRejectedValue(new Error('nope'));
    harness.gateway.registerChannel(asChannel(channel));
    await harness.gateway.start();

    await expect(harness.gateway.stop()).resolves.toBeUndefined();
    expect(harness.gateway.running).toBe(false);
  });

  it('rejects when the port is already in use', async () => {
    const first = tracked(makeGateway({ mode: 'open' }));
    await first.gateway.start();
    const port = boundPort(first.gateway);
    const second = tracked(makeGateway({ mode: 'open' }, { port }));

    await expect(second.gateway.start()).rejects.toThrow();
  });

  it('reports connected channel state in status', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    const channel = makeChannel('feishu');
    harness.gateway.registerChannel(asChannel(channel));
    await harness.gateway.start();

    expect(harness.gateway.getStatus().channels).toEqual([{ type: 'feishu', connected: true }]);
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('RemoteGateway authorization', () => {
  async function deliver(harness: Harness, message: RemoteMessage): Promise<FakeChannel> {
    const channel = makeChannel(message.channelType);
    harness.gateway.registerChannel(asChannel(channel));
    await messageHandlerOf(channel)(message);
    return channel;
  }

  it('routes an open-mode message to the router', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    const channel = await deliver(harness, makeMessage());
    expect(harness.router.routeMessage).toHaveBeenCalledTimes(1);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('denies token-mode channel messages', async () => {
    const harness = tracked(makeGateway({ mode: 'token', token: 'secret' }));
    const channel = await deliver(harness, makeMessage());

    expect(harness.router.routeMessage).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: 'feishu',
        channelId: 'chat-1',
        replyTo: 'msg-1',
        content: expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('没有权限'),
        }),
      })
    );
  });

  it('accepts a scoped allowlist entry', async () => {
    const harness = tracked(makeGateway({ mode: 'allowlist', allowlist: ['feishu:user-1'] }));
    await deliver(harness, makeMessage());
    expect(harness.router.routeMessage).toHaveBeenCalledTimes(1);
  });

  it('accepts a legacy allowlist entry', async () => {
    const harness = tracked(makeGateway({ mode: 'allowlist', allowlist: ['user-1'] }));
    await deliver(harness, makeMessage());
    expect(harness.router.routeMessage).toHaveBeenCalledTimes(1);
  });

  it('denies an empty allowlist', async () => {
    const harness = tracked(makeGateway({ mode: 'allowlist', allowlist: [] }));
    const channel = await deliver(harness, makeMessage());
    expect(harness.router.routeMessage).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('denies an allowlist that does not match', async () => {
    const harness = tracked(makeGateway({ mode: 'allowlist', allowlist: ['other'] }));
    await deliver(harness, makeMessage());
    expect(harness.router.routeMessage).not.toHaveBeenCalled();
  });

  it('accepts a paired user in pairing mode', async () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    harness.gateway.restorePairedUser({
      userId: 'user-1',
      userName: 'Alice',
      channelType: 'feishu',
      pairedAt: 1,
      lastActiveAt: 1,
    });
    await deliver(harness, makeMessage());
    expect(harness.router.routeMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to deny for an unknown auth mode', async () => {
    const harness = tracked(makeGateway({ mode: 'weird' as GatewayAuthConfig['mode'] }));
    await deliver(harness, makeMessage());
    expect(harness.router.routeMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Interceptor and group handling
// ---------------------------------------------------------------------------

describe('RemoteGateway message filtering', () => {
  async function deliver(harness: Harness, message: RemoteMessage): Promise<FakeChannel> {
    const channel = makeChannel(message.channelType);
    harness.gateway.registerChannel(asChannel(channel));
    await messageHandlerOf(channel)(message);
    return channel;
  }

  it('stops routing when the interceptor consumes the message', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    const interceptor = vi.fn(() => true);
    harness.gateway.setMessageInterceptor(interceptor);

    await deliver(harness, makeMessage());

    expect(interceptor).toHaveBeenCalledTimes(1);
    expect(harness.router.routeMessage).not.toHaveBeenCalled();
  });

  it('routes when the interceptor declines the message', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    harness.gateway.setMessageInterceptor(async () => false);

    await deliver(harness, makeMessage());

    expect(harness.router.routeMessage).toHaveBeenCalledTimes(1);
  });

  it('never calls the interceptor for unauthorized users', async () => {
    const harness = tracked(makeGateway({ mode: 'allowlist', allowlist: [] }));
    const interceptor = vi.fn(() => true);
    harness.gateway.setMessageInterceptor(interceptor);

    await deliver(harness, makeMessage());

    expect(interceptor).not.toHaveBeenCalled();
  });

  it('ignores a group message without a mention', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    await deliver(harness, makeMessage({ isGroup: true, isMentioned: false }));
    expect(harness.router.routeMessage).not.toHaveBeenCalled();
  });

  it('accepts a mentioned group message', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    await deliver(harness, makeMessage({ isGroup: true, isMentioned: true }));
    expect(harness.router.routeMessage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

describe('RemoteGateway pairing', () => {
  async function requestPairing(harness: Harness, message = makeMessage()): Promise<FakeChannel> {
    const channel = makeChannel(message.channelType);
    harness.gateway.registerChannel(asChannel(channel));
    await messageHandlerOf(channel)(message);
    return channel;
  }

  it('creates a pending pairing request and notifies the user', async () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    const pairingEvent = vi.fn();
    harness.gateway.on('gateway.pairing_request', pairingEvent);

    const channel = await requestPairing(harness);

    expect(harness.gateway.getPendingPairings()).toHaveLength(1);
    const pending = harness.gateway.getPendingPairings()[0];
    expect(pending.userId).toBe('user-1');
    expect(pending.channelType).toBe('feishu');
    expect(pending.code).toMatch(/^[0-9]{6}$/);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ text: expect.stringContaining(pending.code) }),
      })
    );
    expect(pairingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: pending.code, userId: 'user-1', userName: 'Alice' })
    );
  });

  it('reuses a live pending request instead of minting a new code', async () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    await requestPairing(harness);
    const channel = await requestPairing(harness);

    expect(harness.gateway.getPendingPairings()).toHaveLength(1);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ text: expect.stringContaining('等待管理员确认') }),
      })
    );
  });

  it('issues a fresh code once the previous request expired', async () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    await requestPairing(harness);
    const first = harness.gateway.getPendingPairings()[0];
    internals(harness.gateway).pairingRequests.get('feishu:user-1')!.expiresAt = Date.now() - 1;

    await requestPairing(harness);

    const second = harness.gateway.getPendingPairings()[0];
    expect(second.createdAt).toBeGreaterThanOrEqual(first.createdAt);
    expect(harness.gateway.getPendingPairings()).toHaveLength(1);
  });

  it('approves a pairing request and grants access', async () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    await requestPairing(harness);

    expect(harness.gateway.approvePairing('feishu', 'user-1')).toBe(true);
    expect(harness.gateway.getPairedUsers()).toHaveLength(1);
    expect(harness.gateway.getPendingPairings()).toHaveLength(0);

    await requestPairing(harness);
    expect(harness.router.routeMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses to approve an unknown pairing request', () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    expect(harness.gateway.approvePairing('feishu', 'ghost')).toBe(false);
  });

  it('refuses to approve an expired pairing request', async () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    await requestPairing(harness);
    internals(harness.gateway).pairingRequests.get('feishu:user-1')!.expiresAt = Date.now() - 1;

    expect(harness.gateway.approvePairing('feishu', 'user-1')).toBe(false);
    expect(internals(harness.gateway).pairingRequests.has('feishu:user-1')).toBe(false);
    expect(harness.gateway.getPairedUsers()).toHaveLength(0);
  });

  it('rejects a pairing request', async () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    await requestPairing(harness);

    expect(harness.gateway.rejectPairing('feishu', 'user-1')).toBe(true);
    expect(harness.gateway.getPendingPairings()).toHaveLength(0);
    expect(harness.gateway.getPairedUsers()).toHaveLength(0);
  });

  it('rejects an unknown pairing request', () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    expect(harness.gateway.rejectPairing('feishu', 'ghost')).toBe(false);
  });

  it('revokes an existing pairing', async () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    await requestPairing(harness);
    harness.gateway.approvePairing('feishu', 'user-1');

    expect(harness.gateway.revokePairing('feishu', 'user-1')).toBe(true);
    expect(harness.gateway.revokePairing('feishu', 'user-1')).toBe(false);
    expect(harness.gateway.getPairedUsers()).toHaveLength(0);
  });

  it('restores a persisted pairing once', () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    const user: PairedUser = {
      userId: 'user-9',
      userName: 'Bob',
      channelType: 'telegram',
      pairedAt: 10,
      lastActiveAt: 20,
    };

    harness.gateway.restorePairedUser(user);
    harness.gateway.restorePairedUser({ ...user, userName: 'Hacked' });

    expect(harness.gateway.getPairedUsers()).toEqual([user]);
  });

  it('drops expired requests when listing pending pairings', async () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    await requestPairing(harness);
    internals(harness.gateway).pairingRequests.get('feishu:user-1')!.expiresAt = Date.now() - 1;

    expect(harness.gateway.getPendingPairings()).toEqual([]);
    expect(internals(harness.gateway).pairingRequests.size).toBe(0);
  });

  it('counts pending pairings in the status snapshot', async () => {
    const harness = tracked(makeGateway({ mode: 'pairing' }));
    await requestPairing(harness);
    expect(harness.gateway.getStatus().pendingPairings).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Outbound send
// ---------------------------------------------------------------------------

describe('RemoteGateway sendResponse', () => {
  it('sends through the matching channel', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    const channel = makeChannel('feishu');
    harness.gateway.registerChannel(asChannel(channel));

    await harness.gateway.sendResponse({
      channelType: 'feishu',
      channelId: 'chat-1',
      content: { type: 'text', text: 'pong' },
    });

    expect(channel.send).toHaveBeenCalledWith({
      channelType: 'feishu',
      channelId: 'chat-1',
      content: { type: 'text', text: 'pong' },
    });
  });

  it('does not throw when the channel is missing', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    await expect(
      harness.gateway.sendResponse({
        channelType: 'slack',
        channelId: 'chat-1',
        content: { type: 'text', text: 'x' },
      })
    ).resolves.toBeUndefined();
  });

  it('swallows channel send failures', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    const channel = makeChannel('feishu');
    channel.send.mockRejectedValue(new Error('network down'));
    harness.gateway.registerChannel(asChannel(channel));

    await expect(
      harness.gateway.sendResponse({
        channelType: 'feishu',
        channelId: 'chat-1',
        content: { type: 'text', text: 'x' },
      })
    ).resolves.toBeUndefined();
  });

  it('pipes router responses back to the channel', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    const channel = makeChannel('feishu');
    harness.gateway.registerChannel(asChannel(channel));
    const callback = harness.router.onResponse.mock.calls[0][0] as (r: unknown) => Promise<void>;

    await callback({
      channelType: 'feishu',
      channelId: 'chat-1',
      content: { type: 'text', text: 'streamed' },
    });

    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('emits message.received for routed messages', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    const channel = makeChannel('feishu');
    const received = vi.fn();
    harness.gateway.on('message.received', received);
    harness.gateway.registerChannel(asChannel(channel));

    await messageHandlerOf(channel)(makeMessage());

    expect(received).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// HTTP control endpoints
// ---------------------------------------------------------------------------

describe('RemoteGateway HTTP endpoints', () => {
  it('answers the health check', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    await harness.gateway.start();
    const port = boundPort(harness.gateway);

    const health = await httpRequest(port, '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({
      status: 'ok',
      timestamp: expect.any(Number),
    });

    const root = await httpRequest(port, '/');
    expect(root.status).toBe(200);
  });

  it('serves status without credentials when no token is configured', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    await harness.gateway.start();

    const res = await httpRequest(boundPort(harness.gateway), '/status');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ running: true, activeSessions: 3 });
  });

  it('protects status with the bearer token', async () => {
    const harness = tracked(makeGateway({ mode: 'token', token: 's3cret' }));
    await harness.gateway.start();
    const port = boundPort(harness.gateway);

    const anonymous = await httpRequest(port, '/status');
    expect(anonymous.status).toBe(401);

    const wrong = await httpRequest(port, '/status', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);

    const correct = await httpRequest(port, '/status', {
      headers: { authorization: 'Bearer s3cret' },
    });
    expect(correct.status).toBe(200);
  });

  it('returns 404 for unknown paths', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    await harness.gateway.start();

    const res = await httpRequest(boundPort(harness.gateway), '/nope');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
  });

  it('returns 404 for a webhook of an unregistered channel', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    await harness.gateway.start();

    const res = await httpRequest(boundPort(harness.gateway), '/webhook/telegram', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Channel telegram not found' });
  });

  it('acknowledges a webhook with no listener', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    harness.gateway.registerChannel(asChannel(makeChannel('feishu')));
    await harness.gateway.start();

    const res = await httpRequest(boundPort(harness.gateway), '/webhook/feishu', {
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ code: 0 });
  });

  it('forwards a webhook to its listener and lets it respond', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    harness.gateway.registerChannel(asChannel(makeChannel('feishu')));
    await harness.gateway.start();
    const seen: Array<{
      headers: unknown;
      body: string;
      respond: (s: number, d: unknown) => void;
    }> = [];
    harness.gateway.on('webhook:feishu', (payload: (typeof seen)[number]) => {
      seen.push(payload);
      payload.respond(201, { echoed: true });
    });

    const res = await httpRequest(boundPort(harness.gateway), '/webhook/feishu', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ping: 1 }),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].body).toBe(JSON.stringify({ ping: 1 }));
    expect(seen[0].headers).toMatchObject({ 'content-type': 'application/json' });
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ echoed: true });
  });

  it('returns 500 when a webhook listener throws', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    harness.gateway.registerChannel(asChannel(makeChannel('feishu')));
    await harness.gateway.start();
    harness.gateway.on('webhook:feishu', () => {
      throw new Error('listener exploded');
    });

    const res = await httpRequest(boundPort(harness.gateway), '/webhook/feishu', {
      method: 'POST',
      body: '{}',
    });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal server error' });
  });

  it('rejects an oversized webhook body', async () => {
    const harness = tracked(makeGateway({ mode: 'open' }));
    harness.gateway.registerChannel(asChannel(makeChannel('feishu')));
    await harness.gateway.start();

    const oversized = 'x'.repeat(1024 * 1024 + 64);
    const res = await httpRequest(boundPort(harness.gateway), '/webhook/feishu', {
      method: 'POST',
      body: oversized,
    }).catch((error: NodeJS.ErrnoException) => ({ status: -1, body: String(error.code) }));

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'Request body too large' });
  });
});

// ---------------------------------------------------------------------------
// WebSocket control plane
// ---------------------------------------------------------------------------

describe('RemoteGateway WebSocket', () => {
  async function startWithAuth(
    auth: GatewayAuthConfig
  ): Promise<{ harness: Harness; port: number }> {
    const harness = tracked(makeGateway(auth));
    await harness.gateway.start();
    return { harness, port: boundPort(harness.gateway) };
  }

  it('welcomes a new client with its client id', async () => {
    const { port } = await startWithAuth({ mode: 'open' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);

    const welcome = await probe.next('connected');
    expect(welcome.payload).toMatchObject({ clientId: expect.stringMatching(/^ws-/) });
  });

  it('answers ping with pong', async () => {
    const { port } = await startWithAuth({ mode: 'open' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');

    probe.send({ type: 'ping' });

    expect((await probe.next('pong')).payload).toEqual({});
  });

  it('ignores unknown message types without dropping the client', async () => {
    const { port } = await startWithAuth({ mode: 'open' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');

    probe.send({ type: 'nonsense' });
    probe.send({ type: 'ping' });

    expect((await probe.next('pong')).type).toBe('pong');
  });

  it('survives malformed JSON', async () => {
    const { port } = await startWithAuth({ mode: 'open' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');

    probe.send('{not json');
    probe.send({ type: 'ping' });

    expect((await probe.next('pong')).type).toBe('pong');
  });

  it('authenticates a valid token', async () => {
    const { port } = await startWithAuth({ mode: 'token', token: 'abc123' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');

    probe.send({ type: 'auth', payload: { token: 'abc123' }, requestId: 'r1' });

    const result = await probe.next('auth_result');
    expect(result.payload).toEqual({ success: true });
    expect(result.requestId).toBe('r1');
  });

  it('rejects an invalid token', async () => {
    const { port } = await startWithAuth({ mode: 'token', token: 'abc123' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');

    probe.send({ type: 'auth', payload: { token: 'wrong' } });

    expect((await probe.next('auth_result')).payload).toEqual({
      success: false,
      error: 'Invalid token',
    });
  });

  it('rejects a non-string token', async () => {
    const { port } = await startWithAuth({ mode: 'token', token: 'abc123' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');

    probe.send({ type: 'auth', payload: { token: 42 } });

    expect((await probe.next('auth_result')).payload).toEqual({
      success: false,
      error: 'Invalid token',
    });
  });

  it('authenticates automatically outside token mode', async () => {
    const { port } = await startWithAuth({ mode: 'open' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');

    probe.send({ type: 'auth', payload: {} });

    expect((await probe.next('auth_result')).payload).toEqual({ success: true });
  });

  it('rate limits repeated auth attempts', async () => {
    const { port } = await startWithAuth({ mode: 'token', token: 'abc123' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');

    for (let i = 0; i < 6; i++) {
      probe.send({ type: 'auth', payload: { token: 'wrong' }, requestId: 'r' + i });
    }

    const sixth = await probe.next('auth_result', 6);
    expect(sixth.payload).toEqual({
      success: false,
      error: 'Too many auth attempts. Try again later.',
    });
  });

  it('refuses to route messages before authentication', async () => {
    const { harness, port } = await startWithAuth({ mode: 'token', token: 'abc123' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');

    probe.send({ type: 'message', payload: { text: 'hi' } });

    expect((await probe.next('error')).payload).toEqual({ error: 'Not authenticated' });
    expect(harness.router.routeMessage).not.toHaveBeenCalled();
  });

  it('routes an authenticated client message to the router', async () => {
    const { harness, port } = await startWithAuth({ mode: 'open' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');

    probe.send({ type: 'auth', payload: {} });
    await probe.next('auth_result');
    probe.send({ type: 'message', payload: { text: 'do it' } });

    await waitFor(() => expect(harness.router.routeMessage).toHaveBeenCalledTimes(1));
    expect(harness.router.routeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: 'websocket',
        isGroup: false,
        isMentioned: true,
        content: { type: 'text', text: 'do it' },
        sender: expect.objectContaining({ isBot: false }),
      })
    );
  });

  it('broadcasts only to authenticated clients', async () => {
    const { harness, port } = await startWithAuth({ mode: 'open' });
    const authenticated = await WsProbe.connect(port);
    const anonymous = await WsProbe.connect(port);
    probes.push(authenticated, anonymous);
    await authenticated.next('connected');
    await anonymous.next('connected');

    authenticated.send({ type: 'auth', payload: {} });
    await authenticated.next('auth_result');

    harness.gateway.broadcastWS({ type: 'news', payload: { n: 1 } });

    expect((await authenticated.next('news')).payload).toEqual({ n: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(anonymous.all().some((entry) => entry.type === 'news')).toBe(false);
  });

  it('purges expired auth attempts on the next attempt', async () => {
    const { harness, port } = await startWithAuth({ mode: 'token', token: 'abc123' });
    const state = internals(harness.gateway);
    state.authAttempts.set('10.9.9.9', { count: 3, resetTime: Date.now() - 1 });
    state.lastAuthAttemptPurge = Date.now() - 400000;

    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');
    probe.send({ type: 'auth', payload: { token: 'abc123' } });
    await probe.next('auth_result');

    expect(state.authAttempts.has('10.9.9.9')).toBe(false);
  });

  it('survives a router failure while handling a client message', async () => {
    const { harness, port } = await startWithAuth({ mode: 'open' });
    harness.router.routeMessage.mockRejectedValueOnce(new Error('route exploded'));
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');

    probe.send({ type: 'auth', payload: {} });
    await probe.next('auth_result');
    probe.send({ type: 'message', payload: { text: 'boom' } });

    await waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('Error in handleWSClientMessage'),
        expect.anything()
      )
    );

    probe.send({ type: 'ping' });
    expect((await probe.next('pong')).type).toBe('pong');
  });

  it('drops clients from the registry on close', async () => {
    const { harness, port } = await startWithAuth({ mode: 'open' });
    const probe = await WsProbe.connect(port);
    probes.push(probe);
    await probe.next('connected');
    expect(internals(harness.gateway).wsClients.size).toBe(1);

    probe.close();

    await waitFor(() => expect(internals(harness.gateway).wsClients.size).toBe(0));
  });
});
