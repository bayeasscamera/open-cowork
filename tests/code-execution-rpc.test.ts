import { describe, it, expect } from 'vitest';
import { CodeExecutionRpcBridge } from '../src/main/agent/code-execution-rpc';

describe('CodeExecutionRpcBridge', () => {
  it('executes script and invokes tools via internal RPC', async () => {
    const mockDb: Record<string, string> = {
      'file1.txt': 'Hello World',
      'file2.txt': 'Foo Bar',
    };

    const bridge = new CodeExecutionRpcBridge(async (toolName, args) => {
      if (toolName === 'read_file') {
        const path = args.path as string;
        return mockDb[path] || null;
      }
      if (toolName === 'list_files') {
        return Object.keys(mockDb);
      }
      throw new Error(`Unknown tool: ${toolName}`);
    });

    const script = `
      const files = await tools.call('list_files');
      const contents = [];
      for (const f of files) {
        const content = await tools.call('read_file', { path: f });
        contents.push({ file: f, content });
      }
      tools.log('Read', contents.length, 'files successfully');
      return { total: contents.length, files: contents };
    `;

    const res = await bridge.executeScript(script);

    expect(res.success).toBe(true);
    expect(res.toolCallCount).toBe(3); // 1 list_files + 2 read_file
    expect(res.stdout).toContain('[RPC CALL] list_files');
    expect(res.stdout).toContain('Read 2 files successfully');
    expect(res.result).toEqual({
      total: 2,
      files: [
        { file: 'file1.txt', content: 'Hello World' },
        { file: 'file2.txt', content: 'Foo Bar' },
      ],
    });
  });

  it('catches and reports script syntax or execution errors', async () => {
    const bridge = new CodeExecutionRpcBridge(async () => ({}));
    const res = await bridge.executeScript(`
      throw new Error("Deliberate failure in script");
    `);

    expect(res.success).toBe(false);
    expect(res.error).toContain('Deliberate failure in script');
  });
});
