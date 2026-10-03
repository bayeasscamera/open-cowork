import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The artifact tools only reach the model if the extension is registered on the
 * runtime extension manager. A working ArtifactExtension that nobody registers
 * would leave the store unreachable — and every other test in the suite would
 * still pass, because they construct the extension directly.
 *
 * Both registration sites are asserted: the desktop session manager and the
 * headless one. Missing the headless site would be the quieter failure of the
 * two, since nothing else exercises that path here.
 */
const index = readFileSync(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8');

const registration = /new ArtifactExtension\(\{/g;
const sites = index.match(registration) ?? [];

describe('artifact extension registration', () => {
  it('is registered on both runtime extension managers', () => {
    expect(sites).toHaveLength(2);
    expect(index.match(/new AgentRuntimeExtensionManager\(\[/g) ?? []).toHaveLength(2);
  });

  it('resolves the store lazily rather than capturing it once', () => {
    expect(index).toContain('getStore: getArtifactStore');
    expect(index).toContain('function getArtifactStore(): ArtifactStore');
    // A store captured at construction would be undefined if the database was
    // not yet initialised, breaking every artifact call for the app's lifetime.
    expect(index).not.toContain('getStore: createArtifactStore(getDatabase())');
  });

  it('wires deletion without a confirmation callback, so it fails closed', () => {
    // Both sites deliberately omit confirmDelete: neither manager has a dialog
    // to ask through, so artifact_delete must refuse rather than delete.
    //
    // The block is bounded by its own closing `}),` — splitting on the opening
    // alone would run past the constructor into the rest of the file and pick
    // up unrelated occurrences of the same word.
    const blocks = index
      .split('new ArtifactExtension({')
      .slice(1)
      .map((rest) => rest.split('}),')[0]);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toContain('getStore: getArtifactStore');
      expect(block).not.toContain('confirmDelete');
    }
  });
});