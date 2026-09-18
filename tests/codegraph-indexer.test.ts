import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeGraphIndexer, getCodeGraphIndexer } from '../src/main/memory/codegraph-indexer';

const TS_SAMPLE = [
  'export interface UserProfile {',
  '  name: string;',
  '}',
  '',
  'export type UserRole = "admin" | "user";',
  '',
  'export class UserService {',
  '  findUser() {}',
  '}',
  '',
  'export async function fetchUser(id: string): Promise<UserProfile> {',
  '  const cached = await cacheLookup(id);',
  '  return cached;',
  '}',
  '',
  'const DEFAULT_LIMIT = 10;',
  '',
  '// function notReal() {}',
  "const label = 'class Fake { }';",
  '',
].join('\n');

const PY_SAMPLE = [
  'class PyWorker:',
  '  def run(self):',
  '    pass',
  '',
  'def helper():',
  '  return 1',
  '',
].join('\n');

describe('CodeGraphIndexer', () => {
  let dir: string;
  let indexer: CodeGraphIndexer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cowork-codegraph-'));
    indexer = new CodeGraphIndexer(join(dir, 'cache'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('extracts symbols from TypeScript with the native AST, ignoring comments and strings', async () => {
    writeFileSync(join(dir, 'sample.ts'), TS_SAMPLE);
    const result = await indexer.scanDirectory(dir, ['.ts'], true);

    const names = result.symbols.map((s) => `${s.kind}:${s.name}`).sort();
    expect(names).toEqual([
      'class:UserService',
      'function:fetchUser',
      'interface:UserProfile',
      'type:UserRole',
      'variable:DEFAULT_LIMIT',
      'variable:label',
    ]);
    // Comments and string literals must NOT produce symbols.
    expect(names.some((n) => n.includes('notReal'))).toBe(false);
    expect(names.some((n) => n.includes('Fake'))).toBe(false);

    const fetch = result.symbols.find((s) => s.name === 'fetchUser');
    expect(fetch?.line).toBe(11);
    const cached = result.symbols.find((s) => s.name === 'DEFAULT_LIMIT');
    expect(cached?.line).toBe(16);
  });

  it('uses the regex fallback for non-TypeScript extensions', async () => {
    writeFileSync(join(dir, 'worker.py'), PY_SAMPLE);
    const result = await indexer.scanDirectory(dir, ['.py'], true);
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['PyWorker']);
  });

  it('invalidates only the symbols of the changed file, in memory and cache', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function alpha() {}\n');
    writeFileSync(join(dir, 'b.ts'), 'export function beta() {}\n');
    await indexer.scanDirectory(dir, ['.ts'], true);

    expect(indexer.searchSymbol('alpha').length).toBe(1);
    expect(indexer.searchSymbol('beta').length).toBe(1);

    indexer.invalidateFile(join(dir, 'a.ts'));

    expect(indexer.searchSymbol('alpha').length).toBe(0);
    expect(indexer.searchSymbol('beta').length).toBe(1);

    // The on-disk cache must also be scrubbed: a fresh indexer loading the
    // cache must not resurrect the invalidated file.
    const fresh = new CodeGraphIndexer(join(dir, 'cache'));
    await fresh.scanDirectory(dir, ['.ts']);
    expect(fresh.searchSymbol('alpha').length).toBe(0);
    expect(fresh.searchSymbol('beta').length).toBe(1);
  });

  it('getCodeGraphIndexer returns a shared instance', () => {
    expect(getCodeGraphIndexer()).toBe(getCodeGraphIndexer());
  });
});