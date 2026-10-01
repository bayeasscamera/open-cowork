import { describe, expect, it } from 'vitest';
import {
  applyCoreMemoryActions,
  parseCoreCombinedKey,
  resolveCoreCombinedKey,
} from '../src/main/memory/memory-utils';
import { CoreMemoryStore } from '../src/main/memory/core-memory-store';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Core memory is stored under a key the user never types and never sees:
 * the extractor emits `category` + `key`, and the two are joined into a
 * `combinedKey` that becomes the JSON property name.
 *
 * THAT MAKES THIS A STORED-IDENTITY FUNCTION, not a formatting helper. If
 * the join rule changes, no test fails — the next extraction writes a
 * SECOND row beside the first. `preferences.language` and `preferences-lang`
 * would both answer "what language does the user speak?", neither would ever
 * be updated again, and the cap would eventually evict one of them with no
 * diagnostic. The store would look perfectly healthy the entire time.
 *
 * So the table below is GOLDEN. Every row was produced by the shipping rule,
 * not by reading the code. A changed row is a decision about memories already
 * stored on users' disks, not a test to update.
 */
describe('core memory key derivation (golden)', () => {
  const golden: ReadonlyArray<readonly [string, string | undefined, string]> = [
    // The everyday shape: a known category is prefixed, joined by a dot.
    ['category prefixes the key', 'preferences', 'language'],
    ['each category keeps its own namespace', 'skills', 'typescript'],
    ['identity is a category too', 'identity', 'name'],

    // An unknown category is NOT namespaced — the key stands alone. This is
    // what makes a stray category from the extractor additive rather than
    // data-destroying: it lands on the bare key, never on a typo'd prefix.
    ['unknown category falls back to the bare key', 'nonsense', 'language'],
    ['a bare key with no category is the key', undefined, 'language'],

    // Surrounding whitespace is trimmed once, before anything is decided.
    ['key is trimmed', 'preferences', '  language  '],
    ['a whitespace-only key names nothing', 'preferences', '   '],

    // The separator survives: only the FIRST dot splits a category off, so a
    // key containing dots round-trips through the parser unchanged.
    ['key may contain dots', 'preferences', 'editor.tab.size'],
    ['a key that looks like a category is not split twice', undefined, 'preferences.language'],
  ];

  for (const [name, category, key] of golden) {
    it(`derives: ${name}`, () => {
      expect(resolveCoreCombinedKey(category as never, key)).toMatchSnapshot();
    });
  }

  it('round-trips every golden key through the parser without loss', () => {
    for (const [name, category, key] of golden) {
      const combined = resolveCoreCombinedKey(category as never, key);
      if (!combined) {
        continue;
      }
      const parsed = parseCoreCombinedKey(combined);
      expect(
        { name, combined, parsedCategory: parsed.category, parsedKey: parsed.key },
        `round-trip for "${name}" must rebuild the same key`,
      ).toMatchSnapshot();
    }
  });

  it('produces the same key whether a category is passed or already joined', () => {
    // The extractor may emit `preferences` + `language` or the joined form.
    // Both must land on one row, or the same fact splits in two.
    const split = resolveCoreCombinedKey('preferences', 'language');
    const joined = resolveCoreCombinedKey(undefined, split);
    expect(joined).toBe(split);
  });
});

/**
 * Beads keeps the observation of "was something already here?" in the SAME
 * transaction as the write, so the answer cannot go stale. Here the store is a
 * JSON file rewritten wholesale, which has no transaction — so the guarantee
 * has to come from somewhere else, or the caller is told something optimistic.
 *
 * `Replaced` is what tells the UI whether it UPDATED or CREATED a row. Today
 * `add` and `upsert` are indistinguishable after the fact: both land in the
 * same map and `applied` reports only what was written, never what was there.
 */
describe('core memory reports whether it replaced an existing row', () => {
  let tempRoot: string;
  let filePath: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-core-replaced-'));
    filePath = path.join(tempRoot, 'core_memory.json');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('distinguishes a first write from a second one', () => {
    const store = new CoreMemoryStore(filePath, 24);

    const created = store.applyActions([
      { op: 'upsert', category: 'preferences', key: 'language', value: 'fr' },
    ]);
    const updated = store.applyActions([
      { op: 'upsert', category: 'preferences', key: 'language', value: 'en' },
    ]);

    expect(created[0]).toHaveProperty('replaced', false);
    expect(updated[0]).toHaveProperty('replaced', true);
  });

  it('reports replaced=false for a delete of a key that was never there', () => {
    const store = new CoreMemoryStore(filePath, 24);
    const applied = store.applyActions([
      { op: 'delete', category: 'preferences', key: 'language' },
    ]);
    expect(applied[0]).toHaveProperty('replaced', false);
    expect(store.getRaw()).toEqual({});
  });

  it('reports replaced=true for a delete that removed something', () => {
    const store = new CoreMemoryStore(filePath, 24);
    store.applyActions([
      { op: 'upsert', category: 'preferences', key: 'language', value: 'fr' },
    ]);
    const applied = store.applyActions([{ op: 'delete', category: 'preferences', key: 'language' }]);
    expect(applied[0]).toHaveProperty('replaced', true);
    expect(store.getRaw()).toEqual({});
  });

  it('skips an empty value without reporting a replacement', () => {
    // An empty value is a refusal, not a write. Reporting `replaced` here would
    // claim the store touched a row it never reached.
    const store = new CoreMemoryStore(filePath, 24);
    store.applyActions([
      { op: 'upsert', category: 'preferences', key: 'language', value: 'fr' },
    ]);
    const applied = store.applyActions([
      { op: 'upsert', category: 'preferences', key: 'language', value: '   ' },
    ]);
    expect(applied).toHaveLength(0);
    expect(store.getRaw()['preferences.language']).toBe('fr');
  });

  it('keeps the pure reducer free of store state', () => {
    // applyCoreMemoryActions stays a pure function of (existing, actions);
    // the replacement knowledge is read from the SAME `existing` map it is
    // given, never from a store field that could be out of step with it.
    const existing = { 'preferences.language': 'fr' };
    const { applied } = applyCoreMemoryActions(existing, [
      { op: 'upsert', category: 'preferences', key: 'language', value: 'en' },
    ]);
    expect(applied[0]).toHaveProperty('replaced', true);
    expect(existing['preferences.language']).toBe('fr');
  });
});