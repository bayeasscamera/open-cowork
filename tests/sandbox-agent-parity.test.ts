import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WSL_AGENT = 'src/main/sandbox/wsl-agent/index.ts';
const LIMA_AGENT = 'src/main/sandbox/lima-agent/index.ts';

/**
 * The WSL (Windows) and Lima (macOS) sandbox agents are intentionally separate
 * bundles: each compiles standalone (own tsconfig, rootDir=.) because the
 * compiled index.js is copied into the VM and must be self-contained.
 *
 * Functionally they are the same agent modulo the platform harness. This test
 * applies the canonical WSL→Lima substitution and fails on any divergence
 * beyond the documented platform differences — so a fix applied to one agent
 * but not the other cannot slip through silently.
 */
describe('sandbox agent parity (wsl vs lima)', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

  const CANONICAL_SUBSTITUTIONS: Array<[string, string]> = [
    ['WSL Sandbox Agent', 'Lima Sandbox Agent'],
    ['WSL2', 'Lima VM'],
    ['[WSL-Agent]', '[Lima-Agent]'],
    ['[WSL-Agent ERROR]', '[Lima-Agent ERROR]'],
    ['WSL Sandbox Agent started', 'Lima Sandbox Agent started'],
    ['Failed to start WSL agent', 'Failed to start Lima agent'],
    ['windowsWorkspacePath', 'macWorkspacePath'],
    ['windowsPath', 'macPath'],
    ['WINDOWS_WORKSPACE', 'MAC_WORKSPACE'],
    ['/mnt/', '/Users/'],
    ['Windows paths', 'macOS paths mounted by Lima'],
    ['wslPath', 'limaPath'],
  ];

  const applySubstitutions = (source: string) =>
    CANONICAL_SUBSTITUTIONS.reduce(
      (acc, [from, to]) => acc.split(from).join(to),
      source
    );

  it('both agent sources exist', () => {
    expect(fs.existsSync(path.resolve(process.cwd(), WSL_AGENT))).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), LIMA_AGENT))).toBe(true);
  });

  it('lima agent matches the canonical WSL→Lima transformation (structure parity)', () => {
    const collapsed = (src: string) =>
      src.replace(
        /this\.setWorkspace\(\s*params\.path as string,\s*\(params\.macPath \|\| params\.windowsPath\) as string[^;]*\);/g,
        'this.setWorkspace(params.path as string, params.macPath as string);'
      );

    const transformed = applySubstitutions(collapsed(read(WSL_AGENT))).split('\n');
    const limaLines = collapsed(read(LIMA_AGENT)).split('\n');

    const normalize = (lines: string[]) =>
      lines
        .map(line => line.trim())
        .map(line => (line.startsWith('*') || line.startsWith('//') ? '' : line))
        .filter(line => line.length > 0);

    const expected = normalize(transformed);
    const actual = normalize(limaLines);

    expect(actual.length).toBe(expected.length);
    // Line-by-line comparison gives a precise failure location.
    for (let i = 0; i < expected.length; i += 1) {
      expect(actual[i], `line ${i + 1} diverges: "${expected[i]}" vs "${actual[i]}"`).toBe(
        expected[i]
      );
    }
  });

  it('both agents expose the same public method surface', () => {
    const methodPattern = /^\s{2}(?:async )?(\w+)\(/gm;
    const methods = (src: string) =>
      [...src.matchAll(methodPattern)].map(m => m[1]).sort();
    expect(methods(read(LIMA_AGENT))).toEqual(methods(read(WSL_AGENT)));
  });
});
