import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { VMJsonRpcTransport } from '../src/main/sandbox/vm-jsonrpc-transport';

class TestTransport extends VMJsonRpcTransport {
  protected readonly logTag = '[Test]';
  private stdin: PassThrough | null = null;

  protected getAgentStdin() {
    return this.stdin;
  }

  protected agentName(): string {
    return 'Test';
  }

  attach(stream: PassThrough) {
    this.stdin = stream;
  }

  feed(chunk: string | Buffer) {
    this.ingestStdout(chunk, () => {});
  }

  async call(method: string, params: Record<string, unknown>, timeoutMs?: number) {
    return this.sendRequest<{ ok: boolean }>(method, params, timeoutMs);
  }
}

describe('VMJsonRpcTransport', () => {
  it('rejects requests when the agent is not running', async () => {
    const transport = new TestTransport();
    await expect(transport.call('ping', {})).rejects.toThrow('Test agent not running');
  });

  it('correlates responses by id and resolves the promise', async () => {
    const transport = new TestTransport();
    const { capture, chunks } = captureStream();
    transport.attach(capture);

    const pending = transport.call('ping', {});
    await flush();
    const request = JSON.parse(chunks.join(''));
    expect(request.jsonrpc).toBe('2.0');
    expect(request.method).toBe('ping');

    transport.feed(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\n');
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rejects on error responses', async () => {
    const transport = new TestTransport();
    const { capture, chunks } = captureStream();
    transport.attach(capture);

    const pending = transport.call('boom', {});
    await flush();
    const request = JSON.parse(chunks.join(''));

    transport.feed(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 1, message: 'nope' } }) + '\n');
    await expect(pending).rejects.toThrow('nope');
  });

  it('handles responses split across chunk boundaries', async () => {
    const transport = new TestTransport();
    const { capture, chunks } = captureStream();
    transport.attach(capture);

    const p1 = transport.call('a', {});
    const p2 = transport.call('b', {});
    await flush();
    const ids = chunks.map(c => JSON.parse(c).id);

    const response = JSON.stringify({ jsonrpc: '2.0', id: ids[0], result: { ok: true } });
    transport.feed(response.slice(0, 10));
    transport.feed(response.slice(10) + '\n');
    transport.feed(JSON.stringify({ jsonrpc: '2.0', id: ids[1], result: { ok: false } }) + '\n');

    await expect(p1).resolves.toEqual({ ok: true });
    await expect(p2).resolves.toEqual({ ok: false });
  });

  it('rejects in-flight requests when the agent disconnects', async () => {
    const transport = new TestTransport();
    transport.attach(new PassThrough());

    const pending = transport.call('hang', {});
    await flush();

    transport['failAllPendingRequests']();
    await expect(pending).rejects.toThrow('Test agent disconnected');
  });
});

function captureStream() {
  const capture = new PassThrough();
  const chunks: string[] = [];
  capture.on('data', (d: Buffer) => chunks.push(d.toString()));
  return { capture, chunks };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}
