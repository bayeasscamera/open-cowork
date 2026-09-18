import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MemoryManager } from '../src/main/memory/memory-manager';

/**
 * Causal memory continuity proof: a failure recorded in "session A" must be
 * injected as known-error context into a later session whose prompt matches
 * the same failure pattern.
 */
describe('causal memory continuity across sessions', () => {
  it('injects a recorded failure pattern into the next matching session', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = MEMORY');
    const manager = new MemoryManager(db as unknown as never);

    // Session A: a terminal failure happens (e.g. provider stream error).
    manager.recordErrorPattern(
      'Error: 429 You have reached the request limit',
      'session-terminal-error',
      '',
      'session-A'
    );

    // Session B: a later prompt matching the same failure pattern must
    // receive the known-error context, including the occurrence count.
    const context = manager.formatErrorPatternsForContext(
      'my request fails with: 429 You have reached the request limit'
    );
    expect(context).toContain('<known_error_patterns>');
    // Patterns are stored normalized (lowercase) by recordErrorPattern.
    expect(context).toContain('429 you have reached the request limit');
    expect(context).toContain('seen 1x');

    // An unrelated prompt must not inherit unrelated context.
    const unrelated = manager.formatErrorPatternsForContext('write the readme file');
    expect(unrelated).toBe('');

    db.close();
  });

  it('deduplicates repeated failures by incrementing occurrences', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = MEMORY');
    const manager = new MemoryManager(db as unknown as never);

    manager.recordErrorPattern('Error: ECONNRESET', 'session-terminal-error', '', 'a');
    manager.recordErrorPattern('Error: econnreset', 'session-terminal-error', '', 'b');
    const context = manager.formatErrorPatternsForContext('econnreset');
    expect(context).toContain('seen 2x');
    db.close();
  });
});