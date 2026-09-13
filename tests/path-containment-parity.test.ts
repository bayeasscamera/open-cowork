import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const COPIES = [
  'src/main/tools/path-containment.ts',
  'src/main/sandbox/vm-agent/path-containment.ts',
] as const;

/**
 * The in-VM agent cannot import from `src/shared/` (it compiles standalone),
 * so path-containment is intentionally duplicated into vm-agent/ with inlined
 * Windows-path helpers. These guards fail when a copy silently diverges from
 * the canonical implementation — a containment fix applied to one copy but
 * not the other would be a security regression.
 */
describe('path-containment copy parity', () => {
  it('has exactly the expected copies', () => {
    const onDisk = fs
      .readdirSync(path.resolve(process.cwd(), 'src/main/tools'), { recursive: false })
      .map(f => `src/main/tools/${f}`);
    expect(COPIES[0] && onDisk.includes(COPIES[0])).toBe(true);
  });

  it('all copies export the same API surface', () => {
    const apiPattern = /^export (async )?function (\w+)/gm;
    const apis = COPIES.map(copy => {
      const source = fs.readFileSync(path.resolve(process.cwd(), copy), 'utf8');
      return new Set([...source.matchAll(apiPattern)].map(m => m[2]).sort());
    });
    const reference = [...apis[0]];
    for (const api of apis.slice(1)) {
      expect([...api], `${COPIES[apis.indexOf(api)]} diverges from ${COPIES[0]}`).toEqual(reference);
    }
  });

  it('containment logic bodies are identical across copies', () => {
    const read = (copy: string, dropHeader: number) =>
      fs
        .readFileSync(path.resolve(process.cwd(), copy), 'utf8')
        .split('\n')
        .slice(dropHeader)
        .join('\n');

    // tools/ copy: import line + blank line (2 lines).
    // Agent copy: NOTE comment + inlined helpers (14 lines).
    const canonical = read(COPIES[0], 2);
    for (const copy of COPIES.slice(1)) {
      const agentCopy = read(copy, 14);
      expect(agentCopy, `${copy} logic diverges from ${COPIES[0]}`).toBe(canonical);
    }
  });
});