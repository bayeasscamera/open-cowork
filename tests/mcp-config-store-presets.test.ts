import { describe, it, expect, vi } from 'vitest';

// Mock electron before importing mcp-config-store
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/mock/app/path',
  },
}));

vi.mock('electron-store', () => {
  return {
    default: class MockStore {
      private data: Record<string, unknown> = {};
      get(key: string, defaultValue?: unknown) {
        return this.data[key] ?? defaultValue;
      }
      set(key: string, value: unknown) {
        this.data[key] = value;
      }
    },
  };
});

import { mcpConfigStore } from '../src/main/mcp/mcp-config-store';

describe('mcpConfigStore presets', () => {
  it('includes hindsight in quick add presets', () => {
    const presets = mcpConfigStore.getPresets();
    expect(presets.hindsight).toBeDefined();
    expect(presets.hindsight.name).toBe('Hindsight');
    expect(presets.hindsight.command).toBe('npx');
    expect(presets.hindsight.args).toEqual(['-y', '@vectorize-io/hindsight-coding-agents', 'mcp']);
    expect(presets.hindsight.requiresEnv).toContain('HINDSIGHT_API_KEY');
  });

  it('preserves existing presets (chrome, notion, software-development, gui-operate)', () => {
    const presets = mcpConfigStore.getPresets();
    expect(presets.chrome).toBeDefined();
    expect(presets.notion).toBeDefined();
    expect(presets['software-development']).toBeDefined();
    expect(presets['gui-operate']).toBeDefined();
  });
});
