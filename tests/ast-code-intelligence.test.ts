import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AstCodeIntelligence } from '../src/main/agent/ast-code-intelligence';

describe('AstCodeIntelligence', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-code-intelligence-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds imports and references of a symbol, deduplicated by file+line', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export class Widget {}\n');
    fs.writeFileSync(
      path.join(dir, 'b.ts'),
      "import { Widget } from './a';\nconst w = new Widget();\n"
    );

    const usages = new AstCodeIntelligence(dir).findSymbolUsages('Widget');
    expect(usages.some((u) => u.kind === 'import' && u.filePath.endsWith('b.ts'))).toBe(true);
    expect(usages.some((u) => u.kind === 'reference')).toBe(true);
    expect(usages.some((u) => u.context.includes('Widget'))).toBe(true);

    const keys = usages.map((u) => `${u.filePath}:${u.line}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ignores excluded build/dependency directories', () => {
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'c.ts'), 'const Widget = 1;\n');
    fs.mkdirSync(path.join(dir, 'dist-mcp'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist-mcp', 'd.ts'), 'const Widget = 2;\n');

    expect(new AstCodeIntelligence(dir).findSymbolUsages('Widget')).toEqual([]);
  });

  it('renames whole words only, leaving superstrings untouched', () => {
    fs.writeFileSync(
      path.join(dir, 'a.ts'),
      'const Foo = 1;\nconst FooBar = 2;\nconst myFoo = 3;\n'
    );

    const result = new AstCodeIntelligence(dir).safeRename('Foo', 'Baz');
    const out = fs.readFileSync(path.join(dir, 'a.ts'), 'utf-8');

    expect(out).toContain('const Baz = 1;');
    expect(out).toContain('const FooBar = 2;');
    expect(out).toContain('const myFoo = 3;');
    expect(result.totalReplacements).toBe(1);
  });

  it('reports exported symbols that are never imported elsewhere', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const Used = 1;\nexport const Unused = 2;\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), "import { Used } from './a';\nconsole.log(Used);\n");

    const dead = new AstCodeIntelligence(dir).detectDeadExports().map((d) => d.symbol);
    expect(dead).toContain('Unused');
    expect(dead).not.toContain('Used');
  });
});
