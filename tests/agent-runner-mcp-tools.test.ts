/**
 * Tests for buildMcpCustomTools: bridging MCPManager tools into the agent SDK's
 * ToolDefinition format, result normalization and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { MCPManager, MCPTool } from '../src/main/mcp/mcp-manager';

vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { logError } from '../src/main/utils/logger';
import { buildMcpCustomTools } from '../src/main/agent/agent-runner-mcp-tools';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: { openCoworkImages?: Array<{ data: string; mimeType: string }> };
};

const inputSchema = { type: 'object', properties: { q: { type: 'string' } } } as Record<
  string,
  unknown
>;

const makeTool = (overrides: Partial<MCPTool> = {}): MCPTool =>
  ({
    name: 'search',
    serverName: 'web',
    description: 'Search the web',
    inputSchema,
    toolDefinition: {},
    serverId: 'server-1',
    ...overrides,
  }) as unknown as MCPTool;

const makeManager = (tools: MCPTool[], callTool: ReturnType<typeof vi.fn>): MCPManager =>
  ({ getTools: () => tools, callTool }) as unknown as MCPManager;

const runTool = (
  tool: ToolDefinition,
  params: Record<string, unknown> = {}
): Promise<ToolResult> => {
  const execute = tool.execute as unknown as (
    id: string,
    p: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown
  ) => Promise<ToolResult>;
  return execute('call-1', params, undefined, undefined, {});
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildMcpCustomTools', () => {
  it('returns no tools when the manager exposes none', () => {
    const manager = makeManager([], vi.fn());
    expect(buildMcpCustomTools(manager)).toEqual([]);
  });

  it('maps an MCP tool to a ToolDefinition labelled with its server', () => {
    const manager = makeManager([makeTool()], vi.fn());
    const [tool] = buildMcpCustomTools(manager);

    expect(tool.name).toBe('search');
    expect(tool.label).toBe('web → search');
    expect(tool.description).toBe('Search the web');
    // Type.Unsafe tags the schema with a TypeBox kind symbol, so match structurally.
    expect(tool.parameters).toMatchObject(inputSchema);
  });

  it('prefers originalName in the label and falls back for a missing description', () => {
    const manager = makeManager(
      [makeTool({ originalName: 'web_search', description: '' })],
      vi.fn()
    );
    const [tool] = buildMcpCustomTools(manager);

    expect(tool.label).toBe('web → web_search');
    expect(tool.description).toBe('MCP tool from web');
  });

  it('delegates execute to callTool with the tool name and params', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const manager = makeManager([makeTool()], callTool);
    const [tool] = buildMcpCustomTools(manager);

    await runTool(tool, { q: 'hello' });

    expect(callTool).toHaveBeenCalledWith('search', { q: 'hello' });
  });

  it('returns the textual content and no image details for a text result', async () => {
    const manager = makeManager(
      [makeTool()],
      vi.fn(async () => ({ content: [{ type: 'text', text: 'hello world' }] }))
    );
    const [tool] = buildMcpCustomTools(manager);

    const result = await runTool(tool);

    expect(result.content).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(result.details).toBeUndefined();
  });

  it('exposes image results through details.openCoworkImages', async () => {
    const image = { type: 'image', data: 'AAA', mimeType: 'image/png' };
    const manager = makeManager(
      [makeTool()],
      vi.fn(async () => ({ content: [image] }))
    );
    const [tool] = buildMcpCustomTools(manager);

    const result = await runTool(tool);

    expect(result.details?.openCoworkImages).toEqual([{ data: 'AAA', mimeType: 'image/png' }]);
    expect(result.content[0].text).toContain('image output omitted');
  });

  it('reports (no output) when the MCP result carries an empty content list', async () => {
    const manager = makeManager(
      [makeTool()],
      vi.fn(async () => ({ content: [] }))
    );
    const [tool] = buildMcpCustomTools(manager);

    const result = await runTool(tool);

    expect(result.content[0].text).toBe('(no output)');
    expect(result.details).toBeUndefined();
  });

  it('rethrows the original Error and logs it when callTool fails', async () => {
    const failure = new Error('server exploded');
    const manager = makeManager(
      [makeTool()],
      vi.fn(async () => {
        throw failure;
      })
    );
    const [tool] = buildMcpCustomTools(manager);

    await expect(runTool(tool)).rejects.toBe(failure);
    expect(logError).toHaveBeenCalledWith('[CoworkAgentRunner] MCP tool search failed:', failure);
  });

  it('wraps a non-Error rejection into an Error', async () => {
    const manager = makeManager(
      [makeTool()],
      vi.fn(async () => {
        throw 'boom';
      })
    );
    const [tool] = buildMcpCustomTools(manager);

    await expect(runTool(tool)).rejects.toThrow('boom');
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
