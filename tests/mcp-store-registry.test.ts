import { describe, it, expect } from 'vitest';
import { MCPStoreRegistry } from '../src/main/mcp/mcp-store-registry';

describe('MCPStoreRegistry', () => {
  it('initializes catalog with default items including hindsight', () => {
    const registry = new MCPStoreRegistry();
    const catalog = registry.getCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(6);

    const hindsight = catalog.find((item) => item.id === 'hindsight');
    expect(hindsight).toBeDefined();
    expect(hindsight?.name).toBe('Hindsight Memory');
    expect(hindsight?.command).toBe('npx');
    expect(hindsight?.args).toEqual(['-y', '@vectorize-io/hindsight-coding-agents', 'mcp']);
    expect(hindsight?.category).toBe('devtools');
    expect(hindsight?.envRequirements).toContain('HINDSIGHT_API_KEY');
    expect(hindsight?.installed).toBe(false);
  });

  it('can toggle installed state', () => {
    const registry = new MCPStoreRegistry();
    expect(registry.getInstalled().length).toBe(0);

    const ok = registry.setInstalled('hindsight', true);
    expect(ok).toBe(true);

    const installed = registry.getInstalled();
    expect(installed.length).toBe(1);
    expect(installed[0].id).toBe('hindsight');

    const notFound = registry.setInstalled('non-existent', true);
    expect(notFound).toBe(false);
  });
});
