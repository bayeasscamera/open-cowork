import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
// The client event dispatch table (config.createSet, settings.update, …) lives
// in its own module since the structural refactor.
const indexPath = resolve(root, 'src/main/ipc/client-event-handler.ts');
const typesPath = resolve(root, 'src/shared/types.ts');

function source(file: string): string {
  return readFileSync(file, 'utf8');
}

describe('RPC config-set and sub-agents channels', () => {
  it('declares the config.createSet ClientEvent', () => {
    const types = source(typesPath);
    expect(types).toContain("type: 'config.createSet'");
    expect(types).toContain("payload: { name: string; mode?: 'blank' | 'clone'; fromSetId?: string }");
  });

  it('creates sets via createSet and never exposes credentials in the reply', () => {
    const main = source(indexPath);
    const block = main.slice(
      main.indexOf("case 'config.createSet':"),
      main.indexOf("case 'settings.update':")
    );
    expect(block).toContain('configStore.createSet');
    // Only id and name may leave the main process.
    expect(block).toContain('set.id, name: set.name');
    expect(block).not.toContain('apiKey');
    expect(block).not.toContain('profiles');
  });

  it('restores the previously active set after RPC creation', () => {
    const main = source(indexPath);
    const block = main.slice(
      main.indexOf("case 'config.createSet':"),
      main.indexOf("case 'settings.update':")
    );
    expect(block).toContain('previousActiveId');
    expect(block).toContain('configStore.switchSet({ id: previousActiveId })');
  });

  it('lets settings.update persist non-sensitive sub-agents settings', () => {
    const main = source(indexPath);
    const block = main.slice(
      main.indexOf("case 'settings.update':"),
      main.indexOf('default:')
    );
    expect(block).toContain("configStore.update({ subAgents:");
    // The write path normalizes: update() runs normalizeSubAgentsConfig.
  });
});