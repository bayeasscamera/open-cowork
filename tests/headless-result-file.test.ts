import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  contentBlocksToText,
  parseHeadlessArgs,
  writeResultFileAtomic,
} from '../src/main/cli/headless-io';

const dirs: string[] = [];
const originalArgv = process.argv;

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-headless-result-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  process.argv = originalArgv;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('headless --result-file', () => {
  it('parses the result file path a detached delegation passes', () => {
    process.argv = ['node', 'app', '--headless', '-p', 'hi', '--result-file', '/tmp/r.json'];
    expect(parseHeadlessArgs().resultFile).toBe('/tmp/r.json');
  });

  it('defaults to null when no result file is requested', () => {
    process.argv = ['node', 'app', '--headless', '-p', 'hi'];
    expect(parseHeadlessArgs().resultFile).toBeNull();
  });
});

describe('writeResultFileAtomic', () => {
  it('writes a versioned record and leaves no temp file behind', () => {
    const dir = tmp();
    const file = join(dir, 'nested', 'r.json');
    writeResultFileAtomic(file, { status: 'completed', output: 'the report', finishedAt: 123 });

    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(1);
    expect(raw.status).toBe('completed');
    expect(raw.output).toBe('the report');
    expect(raw.finishedAt).toBe(123);
    expect(readdirSync(join(dir, 'nested'))).toEqual(['r.json']);
  });

  it('records failures too, so a parent never waits forever', () => {
    const file = join(tmp(), 'r.json');
    writeResultFileAtomic(file, { status: 'failed', error: 'boom', finishedAt: 1 });
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(raw.status).toBe('failed');
    expect(raw.error).toBe('boom');
  });
});

describe('contentBlocksToText', () => {
  it('keeps text blocks and drops everything else', () => {
    expect(
      contentBlocksToText([
        { type: 'text', text: 'first' },
        { type: 'thinking', thinking: 'hidden' } as never,
        { type: 'text', text: 'second' },
      ])
    ).toBe('first\nsecond');
    expect(contentBlocksToText([])).toBe('');
  });
});
