/**
 * Tests for the SDK `mcpServers` builder extracted from CoworkAgentRunner.run().
 *
 * Every dependency is injected, so the builder runs without Electron and without
 * the real MCP manager / config store: these tests pin the payload shape, the
 * fingerprint cache and the exact log lines the runner used to emit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../src/main/utils/logger', () => ({
  log: mocks.log,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

import {
  buildMcpServersConfig,
  type McpConfigStoreLike,
  type McpServersCache,
  type McpServersConfigResult,
} from '../src/main/agent/mcp-servers-config';
import type { MCPServerConfig } from '../src/main/mcp/mcp-manager';

const BUNDLED = { node: '/app/bin/node', npx: '/app/bin/npx' };

function server(over: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { id: 'srv-1', name: 'Alpha', type: 'stdio', enabled: true, command: 'npx', args: ['-y', 'pkg'], ...over };
}

function build(options: {
  configs?: MCPServerConfig[];
  imageCapable?: boolean;
  cache?: McpServersCache | null;
  bundled?: typeof BUNDLED | null;
  manager?: { getServerStatus: () => Array<{ id: string; name: string; connected: boolean; status: 'connected'; toolCount: number }> } | undefined;
  store?: Partial<McpConfigStoreLike>;
  getEnabledServersThrows?: boolean;
} = {}): McpServersConfigResult {
  const configs = options.configs ?? [];
  const store: McpConfigStoreLike = {
    getEnabledServers: () => {
      if (options.getEnabledServersThrows) throw new Error('store offline');
      return configs;
    },
    createFromPreset: () => null,
    ...options.store,
  };
  const manager =
    'manager' in options
      ? options.manager
      : { getServerStatus: () => [{ id: 'srv-1', name: 'Alpha', connected: true, status: 'connected' as const, toolCount: 3 }] };
  return buildMcpServersConfig({
    deps: { mcpManager: manager, configStore: store, getBundledNodePaths: () => options.bundled ?? null },
    imageCapable: options.imageCapable ?? true,
    cache: options.cache ?? null,
  });
}

beforeEach(() => {
  delete process.env.COWORK_LOG_SDK_MESSAGES_FULL;
});

describe('buildMcpServersConfig', () => {
  it('returns an empty payload and leaves the cache untouched when MCP is disabled', () => {
    const cache: McpServersCache = { fingerprint: 'kept', servers: { Alpha: { type: 'sse' } } };
    const result = build({ manager: undefined, configs: [server()], cache });
    expect(result.servers).toEqual({});
    expect(result.cache).toBe(cache);
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('logs server statuses and the connected count', () => {
    build({
      manager: {
        getServerStatus: () => [
          { id: 'a', name: 'Alpha', connected: true, status: 'connected' as const, toolCount: 1 },
          { id: 'b', name: 'Beta', connected: false, status: 'connected' as const, toolCount: 0 },
        ],
      },
    });
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] MCP server statuses:', expect.any(String));
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Connected MCP servers:', 1);
  });

  it('builds a stdio server on the bundled npx and prepends the bundled bin to PATH', () => {
    const result = build({ configs: [server({ env: { TOKEN: 't' } })], bundled: BUNDLED, imageCapable: true });
    expect(result.servers.Alpha).toEqual({
      type: 'stdio',
      command: '/app/bin/npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 't', PATH: `${path.dirname(BUNDLED.node)}${path.delimiter}${process.env.PATH || ''}` },
    });
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Added STDIO MCP server: Alpha');
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner]   Tools will be named: mcp__Alpha__<toolName>');
  });

  it('uses the bundled node binary when the config runs node', () => {
    const result = build({ configs: [server({ command: 'node' })], bundled: BUNDLED });
    expect((result.servers.Alpha as { command: string }).command).toBe(BUNDLED.node);
    expect(mocks.log).toHaveBeenCalledWith(`[CoworkAgentRunner]   Added bundled node bin to PATH: ${path.dirname(BUNDLED.node)}`);
  });

  it('keeps the configured command when no bundled binaries are available', () => {
    const result = build({ configs: [server({ command: 'npx' })], bundled: null });
    expect((result.servers.Alpha as { command: string }).command).toBe('npx');
  });

  it('disables image tool output for non image-capable models', () => {
    const result = build({ configs: [server()], bundled: BUNDLED, imageCapable: false });
    const env = (result.servers.Alpha as { env: Record<string, string> }).env;
    expect(env.OPEN_COWORK_DISABLE_IMAGE_TOOL_OUTPUT).toBe('1');
  });

  it('builds an SSE server with empty headers by default', () => {
    const result = build({
      configs: [server({ type: 'sse', url: 'https://mcp.example/sse', command: undefined, args: undefined })],
    });
    expect(result.servers.Alpha).toEqual({ type: 'sse', url: 'https://mcp.example/sse', headers: {} });
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Added SSE MCP server: Alpha');
  });

  it('ignores config types it does not support', () => {
    const result = build({ configs: [server({ type: 'streamable-http', url: 'https://mcp.example' })] });
    expect(result.servers).toEqual({});
  });

  it('stores a fingerprint cache and reuses it for an identical query', () => {
    const configs = [server()];
    const first = build({ configs, bundled: BUNDLED });
    expect(first.cache?.fingerprint).toBe(JSON.stringify(configs) + 'true');
    const second = build({ configs, bundled: BUNDLED, cache: first.cache });
    expect(second.servers).toEqual(first.servers);
    expect(second.cache).toBe(first.cache);
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] MCP servers config reused from cache');
  });

  it('rebuilds when the image capability changes', () => {
    const configs = [server()];
    const first = build({ configs, bundled: BUNDLED, imageCapable: true });
    const second = build({ configs, bundled: BUNDLED, imageCapable: false, cache: first.cache });
    expect(second.cache).not.toBe(first.cache);
    expect((second.servers.Alpha as { env: Record<string, string> }).env.OPEN_COWORK_DISABLE_IMAGE_TOOL_OUTPUT).toBe('1');
  });

  it('expands Software_Development placeholders from the preset', () => {
    const preset = server({ name: 'Software_Development', command: 'node', args: ['/real/server.js'] });
    const result = build({
      configs: [server({ name: 'Software_Development', args: ['{SOFTWARE_DEV_SERVER_PATH}'] })],
      bundled: null,
      store: { createFromPreset: (key) => (key === 'software-development' ? preset : null) },
    });
    expect((result.servers.Software_Development as { args: string[] }).args).toEqual(['/real/server.js']);
    expect(result.servers.Software_Development).toBeDefined();
  });

  it('expands placeholders for the spaced preset names too', () => {
    const guiPreset = server({ name: 'GUI Operate', command: 'node', args: ['/real/gui.js'] });
    const result = build({
      configs: [server({ name: 'GUI Operate', args: ['{GUI_OPERATE_SERVER_PATH}'] })],
      bundled: null,
      store: { createFromPreset: (key) => (key === 'gui-operate' ? guiPreset : null) },
    });
    expect((result.servers['GUI Operate'] as { args: string[] }).args).toEqual(['/real/gui.js']);
  });

  it('keeps the configured args when the name matches no preset', () => {
    const result = build({
      configs: [server({ name: 'Custom', args: ['{SOFTWARE_DEV_SERVER_PATH}'] })],
      bundled: null,
    });
    expect((result.servers.Custom as { args: string[] }).args).toEqual(['{SOFTWARE_DEV_SERVER_PATH}']);
  });

  it('keeps the configured args when the preset has no args', () => {
    const result = build({
      configs: [server({ name: 'Software Development', args: ['{SOFTWARE_DEV_SERVER_PATH}'] })],
      bundled: null,
      store: { createFromPreset: () => server({ args: undefined }) },
    });
    expect((result.servers['Software Development'] as { args: string[] }).args).toEqual(['{SOFTWARE_DEV_SERVER_PATH}']);
  });

  it('skips a server whose preparation throws and keeps the others', () => {
    const broken = server({ name: 'Broken', args: undefined as unknown as string[] });
    (broken as { args?: unknown }).args = { some: () => { throw new Error('bad args'); } };
    const result = build({ configs: [broken, server({ name: 'Healthy' })], bundled: BUNDLED });
    expect(Object.keys(result.servers)).toEqual(['Healthy']);
    expect(mocks.logError).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Failed to prepare MCP server config, skipping server',
      expect.objectContaining({ serverId: 'srv-1', serverName: 'Broken' })
    );
  });

  it('warns and continues with no servers when the store throws', () => {
    const result = build({ getEnabledServersThrows: true });
    expect(result.servers).toEqual({});
    expect(result.cache).toEqual({ fingerprint: '[]true', servers: {} });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Failed to read enabled MCP configs; MCP tools will be unavailable this query',
      expect.any(Error)
    );
  });

  it('summarizes the payload without leaking full configs by default', () => {
    build({ configs: [server({ env: undefined }), server({ name: 'Remote', type: 'sse', url: 'u', args: undefined })], bundled: BUNDLED });
    const summaryCall = mocks.log.mock.calls.find((c) => c[0] === '[CoworkAgentRunner] Final mcpServers summary:');
    expect(summaryCall).toBeDefined();
    expect(JSON.parse(String(summaryCall?.[1]))).toEqual([
      { name: 'Alpha', type: 'stdio', command: '/app/bin/npx', argsCount: 2, envKeys: 1 },
      { name: 'Remote', type: 'sse', command: '', argsCount: 0, envKeys: 0 },
    ]);
    expect(mocks.log.mock.calls.some((c) => c[0] === '[CoworkAgentRunner] Final mcpServers config:')).toBe(false);
  });

  it('tolerates an empty PATH when prepending the bundled bin', () => {
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = '';
      const result = build({ configs: [server()], bundled: BUNDLED });
      const env = (result.servers.Alpha as { env: Record<string, string> }).env;
      expect(env.PATH).toBe(`${path.dirname(BUNDLED.node)}${path.delimiter}`);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('defaults missing stdio args to an empty list', () => {
    const result = build({ configs: [server({ args: undefined })], bundled: BUNDLED });
    expect((result.servers.Alpha as { args: string[] }).args).toEqual([]);
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner]   Command: /app/bin/npx ');
  });

  it('dumps the full payload when COWORK_LOG_SDK_MESSAGES_FULL=1', () => {
    process.env.COWORK_LOG_SDK_MESSAGES_FULL = '1';
    build({ configs: [server()], bundled: BUNDLED });
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Final mcpServers config:', expect.any(String));
  });
});
