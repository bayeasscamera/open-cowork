/**
 * Tests for the pi session tool assembly extracted from run().
 *
 * Every builder is mocked so the composition order, the two environment-bound
 * injections (PATH enrichment, sudo prompt) and the exact registration log
 * lines can be pinned without a runner, Electron or the SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  createCodingTools: vi.fn(() => [{ name: 'coding-tool' }]),
  createWindowsBashOperations: vi.fn(() => ({ ops: true })),
  buildMcpCustomTools: vi.fn(() => [{ name: 'mcp-tool' }]),
  buildAgentMetaTools: vi.fn(() => [{ name: 'meta-tool' }]),
  buildWebTools: vi.fn(() => [{ name: 'web-tool' }]),
  buildImageTools: vi.fn(() => [{ name: 'image-tool' }]),
  wrapBashToolWithDefaultTimeout: vi.fn((tools) => tools),
  wrapBashToolForSudo: vi.fn((tools) => tools),
}));

vi.mock('../src/main/utils/logger', () => ({ log: mocks.log }));
vi.mock('@mariozechner/pi-coding-agent', () => ({
  createCodingTools: mocks.createCodingTools,
}));
vi.mock('../src/main/agent/windows-bash-operations', () => ({
  createWindowsBashOperations: mocks.createWindowsBashOperations,
}));
vi.mock('../src/main/agent/agent-runner-mcp-tools', () => ({
  buildMcpCustomTools: mocks.buildMcpCustomTools,
}));
vi.mock('../src/main/tools/dynamic-tool-creator', () => ({
  buildAgentMetaTools: mocks.buildAgentMetaTools,
}));
vi.mock('../src/main/agent/web-tools', () => ({ buildWebTools: mocks.buildWebTools }));
vi.mock('../src/main/agent/image-tools', () => ({ buildImageTools: mocks.buildImageTools }));
vi.mock('../src/main/agent/agent-runner-bash-tools', () => ({
  wrapBashToolWithDefaultTimeout: mocks.wrapBashToolWithDefaultTimeout,
  wrapBashToolForSudo: mocks.wrapBashToolForSudo,
}));

import {
  buildPiSessionTools,
  type BuildPiSessionToolsDeps,
} from '../src/main/agent/pi-session-tools';

function makeDeps(over: Partial<BuildPiSessionToolsDeps> = {}): BuildPiSessionToolsDeps {
  return {
    mcpManager: undefined,
    sessionId: 'sess-1',
    cwd: '/work',
    extensionCustomTools: [],
    tavilyApiKey: '',
    braveApiKey: '',
    requestSudoPassword: undefined,
    enrichProcessPath: vi.fn(async () => undefined),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createCodingTools.mockReturnValue([{ name: 'coding-tool' }]);
  mocks.buildMcpCustomTools.mockReturnValue([{ name: 'mcp-tool' }]);
  mocks.buildAgentMetaTools.mockReturnValue([{ name: 'meta-tool' }]);
  mocks.buildWebTools.mockReturnValue([{ name: 'web-tool' }]);
  mocks.buildImageTools.mockReturnValue([{ name: 'image-tool' }]);
  mocks.wrapBashToolWithDefaultTimeout.mockImplementation((tools) => tools);
  mocks.wrapBashToolForSudo.mockImplementation((tools) => tools);
});

describe('buildPiSessionTools', () => {
  it('composes custom tools in the historical order', async () => {
    const { customTools } = await buildPiSessionTools(
      makeDeps({
        mcpManager: { id: 'mcp' } as never,
        extensionCustomTools: [{ name: 'ext' }] as never,
      })
    );

    expect(customTools.map((t) => t.name)).toEqual([
      'mcp-tool',
      'ext',
      'meta-tool',
      'web-tool',
      'image-tool',
    ]);
    expect(mocks.buildMcpCustomTools).toHaveBeenCalledWith({ id: 'mcp' });
    expect(mocks.buildAgentMetaTools).toHaveBeenCalledWith({ sessionId: 'sess-1', cwd: '/work' });
    expect(mocks.buildWebTools).toHaveBeenCalledWith({ tavilyApiKey: '', braveApiKey: '' });
    expect(mocks.buildImageTools).toHaveBeenCalledWith({ sessionId: 'sess-1', cwd: '/work' });
  });

  it('skips MCP tools when no manager is configured', async () => {
    const { customTools } = await buildPiSessionTools(makeDeps());

    expect(mocks.buildMcpCustomTools).not.toHaveBeenCalled();
    expect(customTools.map((t) => t.name)).toEqual(['meta-tool', 'web-tool', 'image-tool']);
  });

  it('forwards the resolved search API keys', async () => {
    await buildPiSessionTools(makeDeps({ tavilyApiKey: 'tav', braveApiKey: 'brave' }));

    expect(mocks.buildWebTools).toHaveBeenCalledWith({ tavilyApiKey: 'tav', braveApiKey: 'brave' });
  });

  it('logs MCP and extension registrations with exact counts', async () => {
    await buildPiSessionTools(
      makeDeps({
        mcpManager: {} as never,
        extensionCustomTools: [{ name: 'ext-a' }, { name: 'ext-b' }] as never,
      })
    );

    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Registered 6 total customTools (MCP: 1):',
      'mcp-tool, ext-a, ext-b, meta-tool, web-tool, image-tool'
    );
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Registered 2 extension tools as customTools:',
      'ext-a, ext-b'
    );
  });

  it('stays silent when there are no MCP or extension tools', async () => {
    await buildPiSessionTools(makeDeps());

    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('enriches PATH between custom-tool assembly and coding-tool creation', async () => {
    const order: string[] = [];
    mocks.buildMcpCustomTools.mockImplementation(() => {
      order.push('mcp');
      return [];
    });
    mocks.createCodingTools.mockImplementation(() => {
      order.push('coding');
      return [];
    });
    const enrichProcessPath = vi.fn(async () => {
      order.push('enrich');
    });

    await buildPiSessionTools(makeDeps({ mcpManager: {} as never, enrichProcessPath }));

    expect(order).toEqual(['mcp', 'enrich', 'coding']);
  });

  it('wraps the coding tools with the timeout and sudo layers', async () => {
    const requestSudoPassword = vi.fn(async () => 'pw');
    const coding = [{ name: 'bash' }];
    mocks.createCodingTools.mockReturnValue(coding);
    mocks.wrapBashToolWithDefaultTimeout.mockReturnValue([{ name: 'timed' }]);

    const { wrappedTools } = await buildPiSessionTools(makeDeps({ requestSudoPassword }));

    expect(mocks.createCodingTools).toHaveBeenCalledWith('/work', undefined);
    expect(mocks.wrapBashToolWithDefaultTimeout).toHaveBeenCalledWith(coding);
    expect(mocks.wrapBashToolForSudo).toHaveBeenCalledWith([{ name: 'timed' }], {
      requestSudoPassword,
      sessionId: 'sess-1',
      effectiveCwd: '/work',
    });
    expect(wrappedTools).toEqual([{ name: 'timed' }]);
  });

  it('creates Windows bash operations only on win32', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await buildPiSessionTools(makeDeps());

      expect(mocks.createWindowsBashOperations).toHaveBeenCalledTimes(1);
      expect(mocks.createCodingTools).toHaveBeenCalledWith('/work', {
        bash: { operations: { ops: true } },
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});
