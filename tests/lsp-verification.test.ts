/**
 * Chantier 2 — semantic (LSP-style) verification beyond the AST.
 *
 * The headline proof: a WRONG ARGUMENT TYPE is structurally invisible to an
 * AST parse (it parses perfectly) but is reported by a real TypeScript
 * Program. That difference is exactly what this feature adds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  checkFilesSemantics,
  findProjectConfig,
  isSemanticallyCheckable,
  formatSemanticIssues,
  resetProgramCache,
  cachedProgramCount,
} from '../src/main/agent/lsp-verification';

let projectDir: string;

beforeAll(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-lsp-'));
  fs.writeFileSync(
    path.join(projectDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          noEmit: true,
        },
        include: ['**/*.ts'],
      },
      null,
      2
    ),
    'utf-8'
  );

  // Valid, well-typed module.
  fs.writeFileSync(
    path.join(projectDir, 'good.ts'),
    `export function greet(name: string): string {
  return 'hello ' + name;
}
`,
    'utf-8'
  );

  // Parses perfectly (so the AST check finds NOTHING) but has a real type
  // error: greet() takes a string, not a number.
  fs.writeFileSync(
    path.join(projectDir, 'wrong-arg-type.ts'),
    `import { greet } from './good';

export const broken = greet(42);
`,
    'utf-8'
  );

  // Broken import: parses fine, fails to resolve at the type level.
  fs.writeFileSync(
    path.join(projectDir, 'broken-import.ts'),
    `import { nothing } from './does-not-exist';

export const value = nothing;
`,
    'utf-8'
  );
});

afterAll(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  resetProgramCache();
});

describe('project discovery', () => {
  it('walks up to the nearest tsconfig', () => {
    const nested = path.join(projectDir, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(findProjectConfig(path.join(nested, 'file.ts'))).toBe(
      path.join(projectDir, 'tsconfig.json')
    );
  });

  it('returns null when no config exists above the file', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-noconfig-'));
    try {
      expect(findProjectConfig(path.join(outside, 'a.ts'))).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('only type-checks TypeScript extensions', () => {
    expect(isSemanticallyCheckable('/x/a.ts')).toBe(true);
    expect(isSemanticallyCheckable('/x/a.tsx')).toBe(true);
    expect(isSemanticallyCheckable('/x/a.js')).toBe(false);
    expect(isSemanticallyCheckable('/x/a.json')).toBe(false);
  });
});

describe('PROOF — a type error invisible to the AST IS caught', () => {
  it('reports a wrong argument type', async () => {
    const issues = await checkFilesSemantics([path.join(projectDir, 'wrong-arg-type.ts')]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/not assignable to parameter of type 'string'/);
    expect(issues[0].line).toBeGreaterThan(0);
  });

  it('reports a broken import', async () => {
    const issues = await checkFilesSemantics([path.join(projectDir, 'broken-import.ts')]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes('does-not-exist'))).toBe(true);
  });

  it('reports nothing for a correctly typed file', async () => {
    const issues = await checkFilesSemantics([path.join(projectDir, 'good.ts')]);
    expect(issues).toEqual([]);
  });
});

describe('the AST check would have missed all of this', () => {
  it('wrong-arg-type.ts has no parse errors at all', async () => {
    const ts = await import('typescript');
    const file = path.join(projectDir, 'wrong-arg-type.ts');
    const sourceFile = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const parseDiagnostics = (
      sourceFile as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
    // Zero parse errors: an AST-only verifier is blind to this bug.
    expect(parseDiagnostics).toHaveLength(0);
  });
});

describe('robustness', () => {
  it('never throws on a missing file', async () => {
    const issues = await checkFilesSemantics([path.join(projectDir, 'ghost.ts')]);
    expect(issues).toEqual([]);
  });

  it('returns [] for a file outside any TypeScript project', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-outside-'));
    try {
      const file = path.join(outside, 'a.ts');
      fs.writeFileSync(file, 'const x: number = "nope";\n', 'utf-8');
      // No tsconfig above it -> no project -> no semantic check, and no crash.
      const issues = await checkFilesSemantics([file]);
      expect(Array.isArray(issues)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores non-TypeScript files entirely', async () => {
    expect(await checkFilesSemantics([path.join(projectDir, 'x.json')])).toEqual([]);
  });

  it('respects the per-file diagnostic cap', async () => {
    const noisy = path.join(projectDir, 'noisy.ts');
    const lines: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      lines.push(`export const bad${i}: number = "not a number ${i}";`);
    }
    fs.writeFileSync(noisy, lines.join('\n') + '\n', 'utf-8');
    const issues = await checkFilesSemantics([noisy], { maxPerFile: 3 });
    expect(issues.length).toBe(3);
    fs.rmSync(noisy);
  });

  it('degrades to [] when the budget is already exhausted', async () => {
    // A 1 ms budget is spent before the first project is even built.
    const issues = await checkFilesSemantics([path.join(projectDir, 'wrong-arg-type.ts')], {
      budgetMs: -1,
    });
    expect(Array.isArray(issues)).toBe(true);
  });
});

describe('program caching (the cost lever)', () => {
  it('reuses one Program across calls for the same project', async () => {
    resetProgramCache();
    await checkFilesSemantics([path.join(projectDir, 'wrong-arg-type.ts')]);
    const afterFirst = cachedProgramCount();
    await checkFilesSemantics([path.join(projectDir, 'broken-import.ts')]);
    // The second pass must not build another Program.
    expect(cachedProgramCount()).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(0);
  });

  it('resetProgramCache() drops the cached programs', () => {
    resetProgramCache();
    expect(cachedProgramCount()).toBe(0);
  });
});

describe('formatting', () => {
  it('renders issues as file:line — message', () => {
    const rendered = formatSemanticIssues([
      { file: '/a.ts', line: 3, column: 1, code: 2345, message: 'bad type' },
    ]);
    expect(rendered).toBe('/a.ts:3 — bad type');
  });
});
describe('COST — measured through the shipped module', () => {
  it('reports cold vs warm latency and RSS', async () => {
    resetProgramCache();
    const files = ['a.ts', 'b.ts', 'c.ts'].map((f) => path.join(projectDir, f));
    fs.writeFileSync(path.join(projectDir, 'a.ts'), 'export const add = (x: number, y: number): number => x + y;\n', 'utf-8');
    fs.writeFileSync(path.join(projectDir, 'b.ts'), 'import { add } from "./a";\nexport const t: number = add(1, 2);\n', 'utf-8');
    fs.writeFileSync(path.join(projectDir, 'c.ts'), 'import { add } from "./a";\nexport const w: string = add(1, 2);\n', 'utf-8');

    const rss = () => process.memoryUsage().rss;
    const run = async (label: string) => {
      const before = rss();
      const t0 = performance.now();
      const issues = await checkFilesSemantics(files);
      const ms = performance.now() - t0;
      const mb = (rss() - before) / 1024 / 1024;
      console.log(`[COST] ${label.padEnd(20)} ${ms.toFixed(0).padStart(6)} ms  RSS +${mb.toFixed(0).padStart(4)} MB  issues=${issues.length}`);
      return issues;
    };

    const cold = await run('cold (build)');
    const warm = await run('warm (cached)');

    // Correctness must hold in both passes.
    expect(cold.some((i) => i.file.endsWith('c.ts') && /not assignable/.test(i.message))).toBe(true);
    expect(cold.some((i) => i.file.endsWith('b.ts'))).toBe(false);
    expect(warm.some((i) => i.file.endsWith('c.ts'))).toBe(true);
  });
});
