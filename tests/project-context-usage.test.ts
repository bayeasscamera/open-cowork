import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

let testRoot = mkdtempSync(join(tmpdir(), 'cowork-project-usage-'));

vi.mock('electron', () => ({
  app: {
    getPath: () => testRoot,
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import { computeProjectContextUsage } from '../src/main/projects/project-context';
import type { Project } from '../src/shared/types';

const workdir = join(testRoot, 'usage-workdir');

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function project(overrides: Partial<Project>): Project {
  return {
    id: 'p-usage',
    name: 'Usage',
    description: null,
    workdir,
    configSetId: null,
    instructions: null,
    archived: false,
    referenceFiles: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// Real injection budget mirrored by the UI progress bar:
// instructions ≤ 8 000 chars + files ≤ 8 000 chars each, 8 files max,
// 32 000 chars total for files → 40 000 chars max.
describe('computeProjectContextUsage — real injection budget', () => {
  it('counts instructions and file chars against the 40k budget', () => {
    const p = project({ instructions: 'abc', referenceFiles: [] });
    const usage = computeProjectContextUsage(p);
    expect(usage.instructionsChars).toBe(3);
    expect(usage.filesChars).toBe(0);
    expect(usage.maxChars).toBe(40000);
  });

  it('caps a single oversized file at 8 000 chars', () => {
    mkdirSync(workdir, { recursive: true });
    const big = join(workdir, 'big.md');
    writeFileSync(big, 'x'.repeat(12000), 'utf-8');
    const usage = computeProjectContextUsage(project({ referenceFiles: [big] }));
    expect(usage.filesChars).toBe(8000);
    expect(usage.filesInjected).toBe(1);
  });

  it('stops injecting after the 32 000-char file budget (and reports the overflow)', () => {
    const files: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const f = join(workdir, `f${i}.md`);
      writeFileSync(f, 'y'.repeat(7000), 'utf-8');
      files.push(f);
    }
    const usage = computeProjectContextUsage(project({ referenceFiles: files }));
    // 6 × 7 000 = 42 000 > 32 000 → the last file is partially injected, budget hit.
    expect(usage.filesChars).toBe(32000);
    expect(usage.filesTotal).toBe(6);
  });

  it('ignores files beyond the first 8 (filesInjected < filesTotal)', () => {
    const files: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const f = join(workdir, `small${i}.md`);
      writeFileSync(f, 'z'.repeat(100), 'utf-8');
      files.push(f);
    }
    const usage = computeProjectContextUsage(project({ referenceFiles: files }));
    expect(usage.filesInjected).toBe(8);
    expect(usage.filesTotal).toBe(10);
    expect(usage.filesChars).toBe(800);
  });

  it('unreadable files contribute 0 chars without throwing', () => {
    const usage = computeProjectContextUsage(
      project({ referenceFiles: [join(testRoot, 'missing-4402.md')] })
    );
    expect(usage.filesChars).toBe(0);
    expect(usage.filesInjected).toBe(1);
  });
});