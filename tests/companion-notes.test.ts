/**
 * @module tests/companion-notes
 *
 * Tests for Daily Companion Personal Notes & MemoryManager persistence.
 */

import { describe, expect, it } from 'vitest';
import { MemoryManager } from '../src/main/memory/memory-manager';
import { buildAgentMetaTools } from '../src/main/tools/dynamic-tool-creator';
import { STANDARD_PRESET } from '../src/main/presets/builtin-presets';

/**
 * In-memory mock database implementing SQLite interface for tests
 * without native binary compilation dependencies.
 */
function createMockSqliteDb() {
  const store: Record<string, any[]> = {
    user_notes: [],
    error_patterns: [],
    user_preferences: [],
    project_context: [],
  };

  return {
    exec: (_sql: string) => {},
    prepare: (sql: string) => {
      const normalized = sql.trim().toLowerCase();

      return {
        run: (...args: any[]) => {
          if (normalized.startsWith('insert into user_notes')) {
            const [id, title, content, tags, created_at, updated_at] = args;
            store.user_notes.push({
              id,
              title,
              content,
              tags,
              pinned: 0,
              created_at,
              updated_at,
            });
            return { changes: 1 };
          }
          if (normalized.startsWith('update user_notes')) {
            const id = args[args.length - 1];
            const note = store.user_notes.find((n) => n.id === id);
            if (note) {
              const setClause = normalized.replace('update user_notes set ', '').split(' where ')[0];
              const fields = setClause.split(',').map((s) => s.trim());
              fields.forEach((field, i) => {
                if (field.startsWith('pinned')) note.pinned = Number(args[i]);
                if (field.startsWith('title')) note.title = args[i];
                if (field.startsWith('content')) note.content = args[i];
                if (field.startsWith('tags')) note.tags = args[i];
                if (field.startsWith('updated_at')) note.updated_at = Number(args[i]);
              });
              return { changes: 1 };
            }
            return { changes: 0 };
          }
          if (normalized.startsWith('delete from user_notes')) {
            const id = args[0];
            const idx = store.user_notes.findIndex((n) => n.id === id);
            if (idx >= 0) {
              store.user_notes.splice(idx, 1);
              return { changes: 1 };
            }
            return { changes: 0 };
          }
          return { changes: 0 };
        },
        get: (..._args: any[]) => undefined,
        all: (...args: any[]) => {
          if (normalized.includes('from user_notes')) {
            if (normalized.includes('like ?')) {
              const term = (args[0] as string).replace(/%/g, '').toLowerCase();
              return store.user_notes.filter(
                (n) => n.title.toLowerCase().includes(term) || n.content.toLowerCase().includes(term)
              );
            }
            return [...store.user_notes].sort((a, b) => b.pinned - a.pinned || b.updated_at - a.updated_at);
          }
          return [];
        },
      };
    },
    close: () => {},
  };
}

describe('Daily Companion Notes (MemoryManager)', () => {
  it('creates, retrieves, searches, updates, and deletes personal notes', () => {
    const db = createMockSqliteDb();
    const manager = new MemoryManager(db as unknown as never);

    // Initially empty
    expect(manager.getAllNotes()).toEqual([]);
    expect(manager.formatNotesForContext()).toBe('');

    // Add note 1
    const id1 = manager.addNote('Framework preference', 'Always use Vitest and Tailwind CSS', ['tech', 'style']);
    expect(typeof id1).toBe('string');
    expect(id1.length).toBeGreaterThan(0);

    // Add note 2 (pinned)
    const id2 = manager.addNote('Daily schedule', 'Work sessions from 9h to 18h', ['routine']);
    manager.updateNote(id2, { pinned: true });

    const notes = manager.getAllNotes();
    expect(notes.length).toBe(2);
    // Pinned note comes first
    expect(notes[0].id).toBe(id2);
    expect(notes[0].pinned).toBe(true);
    expect(notes[1].id).toBe(id1);
    expect(notes[1].tags).toEqual(['tech', 'style']);

    // Search notes
    const searchTech = manager.searchNotes('Tailwind');
    expect(searchTech.length).toBe(1);
    expect(searchTech[0].id).toBe(id1);

    const searchRoutine = manager.searchNotes('schedule');
    expect(searchRoutine.length).toBe(1);
    expect(searchRoutine[0].id).toBe(id2);

    // Format notes for prompt context
    const context = manager.formatNotesForContext();
    expect(context).toContain('<user_notes>');
    expect(context).toContain('★ Daily schedule: Work sessions from 9h to 18h [routine]');
    expect(context).toContain('- Framework preference: Always use Vitest and Tailwind CSS [tech, style]');

    // Update note 1
    const updated = manager.updateNote(id1, { content: 'Use Vitest only' });
    expect(updated).toBe(true);
    const reloaded = manager.getAllNotes().find((n) => n.id === id1);
    expect(reloaded?.content).toBe('Use Vitest only');

    // Delete note 1
    const deleted = manager.deleteNote(id1);
    expect(deleted).toBe(true);
    expect(manager.getAllNotes().length).toBe(1);
  });

  it('runs remember_note tool and persists to MemoryManager', async () => {
    const db = createMockSqliteDb();
    const manager = new MemoryManager(db as unknown as never);

    const tools = buildAgentMetaTools({
      memoryManager: manager,
    });
    const rememberTool = tools.find((t) => t.name === 'remember_note');
    expect(rememberTool).toBeDefined();

    const result = await rememberTool!.execute('call-1', {
      title: 'Secret Habit',
      content: 'Prefers concise caveman communication',
      tags: ['communication', 'style'],
    });

    expect(result.details).toMatchObject({ success: true });
    expect(typeof (result.details as { noteId: string }).noteId).toBe('string');

    const notes = manager.getAllNotes();
    expect(notes.length).toBe(1);
    expect(notes[0].title).toBe('Secret Habit');
    expect(notes[0].content).toBe('Prefers concise caveman communication');
    expect(notes[0].tags).toEqual(['communication', 'style']);
  });

  it('handles remember_note tool when memoryManager is missing gracefully', async () => {
    const tools = buildAgentMetaTools({});
    const rememberTool = tools.find((t) => t.name === 'remember_note');
    expect(rememberTool).toBeDefined();

    const result = await rememberTool!.execute('call-2', {
      title: 'Missing Context',
      content: 'Should not crash',
    });

    expect(result.details).toMatchObject({ success: false });
    expect((result.content[0] as { text: string }).text).toContain('MemoryManager not available');
  });

  it('includes remember_note in STANDARD_PRESET tools allow list', () => {
    expect(STANDARD_PRESET.tools.allow).toContain('remember_note');
  });
});
