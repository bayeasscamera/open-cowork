/**
 * Unit tests for the memory creation-time context signature.
 *
 * The signature is what lets the runner reuse a cached SDK session while memory
 * is enabled: it changes only when the system-prompt block or the tool surface
 * the SDK actually sees changes.
 */

import { describe, expect, it } from 'vitest';
import { buildMemorySessionContextSignature } from '../src/main/memory/memory-extension';

const tool = (name?: string, description?: string) => ({ name, description });

describe('buildMemorySessionContextSignature', () => {
  it('is a deterministic 64-char sha256 for identical inputs', () => {
    const first = buildMemorySessionContextSignature('ctx', [tool('memory_read', 'Read')]);
    const second = buildMemorySessionContextSignature('ctx', [tool('memory_read', 'Read')]);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the system context changes', () => {
    expect(buildMemorySessionContextSignature('ctx-a', [])).not.toBe(
      buildMemorySessionContextSignature('ctx-b', [])
    );
  });

  it('changes when a tool name or description changes', () => {
    const base = buildMemorySessionContextSignature('ctx', [tool('memory_read', 'Read')]);

    expect(buildMemorySessionContextSignature('ctx', [tool('memory_write', 'Read')])).not.toBe(
      base
    );
    expect(buildMemorySessionContextSignature('ctx', [tool('memory_read', 'Write')])).not.toBe(
      base
    );
  });

  it('changes when a tool is added or removed', () => {
    const one = buildMemorySessionContextSignature('ctx', [tool('memory_read', 'Read')]);
    const two = buildMemorySessionContextSignature('ctx', [
      tool('memory_read', 'Read'),
      tool('memory_write', 'Write'),
    ]);

    expect(two).not.toBe(one);
  });

  it('ignores tool order and non-surface fields', () => {
    const read = { name: 'memory_read', description: 'Read', execute: () => undefined };
    const write = { name: 'memory_write', description: 'Write' };

    const first = buildMemorySessionContextSignature('ctx', [read, write]);
    const second = buildMemorySessionContextSignature('ctx', [write, read]);

    expect(first).toBe(second);
  });

  it('treats a missing name or description as an empty string', () => {
    expect(buildMemorySessionContextSignature('ctx', [{}, {}])).toBe(
      buildMemorySessionContextSignature('ctx', [
        { name: '', description: '' },
        { name: '', description: '' },
      ])
    );
  });
});
