import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Structural guarantees about where `new Function` / `eval` may appear.
 *
 * The architecture rule is: model-written code is never evaluated in the main
 * process. The one permitted eval lives in the run_code CHILD, which holds no
 * authority. That rule is easy to erode — someone adds an import, a helper gets
 * an `eval`, and the guarantee quietly stops holding while every test still
 * passes. These are source-level assertions on purpose: they catch the
 * architectural change, which a behavioural test cannot see.
 */

const SRC = 'src';
const MAIN = 'src/main';
const MAIN_ENTRY = 'src/main/index.ts';
const CHILD_ENTRY = 'main/agent/run-code-child-main.ts';
const CHILD_MODULE = 'main/agent/run-code-child.ts';

/** Every TypeScript source file under src/. */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Strip comments so a doc comment that quotes `eval` is not a finding. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the main process never evaluates model-written code', () => {
  it('exactly one source file evaluates code, and it is the run_code child', () => {
    const offenders = sourceFiles()
      .filter((file) => {
        const code = stripComments(read(file));
        return /(^|[^.\w])eval\s*\(/.test(code) || /new\s+Function\s*\(/.test(code);
      })
      .map((file) => path.relative(SRC, file));

    expect(offenders).toEqual([CHILD_MODULE]);
  });

  it('the file that evaluates code is reachable only from the child entry', () => {
    const childModuleName = path.basename(CHILD_MODULE).replace('.ts', '');
    const importers = sourceFiles().filter(
      (file) =>
        path.basename(file) !== CHILD_MODULE && read(file).includes(`from './${childModuleName}'`)
    );

    expect(importers.map((f) => path.relative(SRC, f))).toEqual([CHILD_ENTRY]);
  });

  it('no file under the main-process entry graph imports the child module', () => {
    // A transitive import would put the eval in the main bundle even though no
    // single file imports it directly, which is exactly the erosion to prevent.
    const mainGraph = new Set<string>();
    const visit = (file: string): void => {
      if (mainGraph.has(file)) return;
      mainGraph.add(file);
      const source = read(file);
      for (const match of source.matchAll(/from '(\.[^']+)'/g)) {
        const resolved = path
          .relative(SRC, path.resolve(path.dirname(file), `${match[1]}.ts`))
          .replace(/\\/g, '/');
        const onDisk = path.join(SRC, resolved);
        if (statSync(onDisk, { throwIfNoEntry: false })?.isFile()) visit(onDisk);
      }
    };

    visit(MAIN_ENTRY);

    // Relative to src/main, since that is the graph we walked.
    const reached = [...mainGraph].map((f) => path.relative(MAIN, f).replace(/\\/g, '/'));
    expect(reached).not.toContain(CHILD_MODULE);
    expect(reached).not.toContain(CHILD_ENTRY);
  });

  it('the dead code-execution RPC bridge is gone, not merely unused', () => {
    // It was the last eval path in the main process. Asserting absence rather
    // than "unreferenced" so a reintroduction fails loudly.
    expect(readdirSync(path.join(MAIN, 'agent'))).not.toContain('code-execution-rpc.ts');
  });

  it('the child module documents that it must stay out of the main graph', () => {
    const header = read(path.join(SRC, CHILD_MODULE)).slice(0, 2000);
    expect(header).toContain('out of the main process');
    expect(header).toContain('import graph');
  });
});

describe('the main process build cannot pull the child in through configuration', () => {
  it('the child entry is not wired into the main package entry', () => {
    // The child is bundled as its own output. The real guard is the import-graph
    // test above; this only catches the child being named as the main entry.
    const pkg = read('package.json');
    expect(pkg).not.toMatch(/"main"\s*:[^}]*run-code-child/);
  });
});
