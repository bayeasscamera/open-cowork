import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryFilesStore } from '../src/main/memory/memory-files-store';
import {
  PersonalFilesManager,
  personalFilesHandler,
} from '../src/main/memory/personal-files-manager';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  const store = new MemoryFilesStore(db);
  const manager = new PersonalFilesManager(
    () => store,
    () => 'local-test'
  );
  const webContents = { mainFrame: {}, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { db, store, manager, window, event };
}

describe('personal files trusted handler and SQLite management', () => {
  it('lists, reads, shows history and restores a backend revision as a new CAS version', () => {
    const { store, manager, window, event } = setup();
    const first = store.write('local-test', '/profile.md', 'fictional preference A', 'new');
    const second = store.write(
      'local-test',
      '/profile.md',
      'fictional preference B',
      first.version
    );
    store.write('other-owner', '/private.md', 'other fixture', 'new');
    expect(
      personalFilesHandler(
        () => window,
        () => manager.list()
      )(event)
    ).toMatchObject({ success: true, data: [{ path: '/profile.md' }] });
    expect(manager.read('/profile.md')).toMatchObject({
      success: true,
      data: { content: 'fictional preference B' },
    });
    const history = manager.history('/profile.md');
    expect(history.success && history.data.length).toBe(2);
    expect(JSON.stringify(history)).not.toContain('local-test');
    const restore = personalFilesHandler(
      () => window,
      (input) => manager.restore(input)
    );
    const request = {
      path: '/profile.md',
      generation: first.generation,
      revision: first.revision,
      expectedVersion: second.version,
    };
    expect(restore(event, { ...request, owner: 'other-owner' })).toEqual({
      success: false,
      error: 'invalid_input',
    });
    expect(restore(event, { ...request, content: 'forged content' })).toEqual({
      success: false,
      error: 'invalid_input',
    });
    expect(manager.read('/private.md')).toEqual({ success: false, error: 'not_found' });
    expect(manager.history('/private.md')).toEqual({ success: true, data: [] });
    const result = restore(event, {
      path: '/profile.md',
      generation: first.generation,
      revision: first.revision,
      expectedVersion: second.version,
    });
    expect(result).toMatchObject({ success: true, data: { content: 'fictional preference A' } });
    expect(result.success && result.data.version).not.toBe(first.version);
    expect(store.readHistory('local-test', '/profile.md')).toHaveLength(3);
    expect(
      restore(event, {
        path: '/profile.md',
        generation: first.generation,
        revision: first.revision,
        expectedVersion: second.version,
      })
    ).toEqual({ success: false, error: 'version_conflict' });
  });

  it('rejects untrusted senders, subframes, renderer ownership and invalid inputs', () => {
    const { manager, window, event } = setup();
    const handler = personalFilesHandler(
      () => window,
      () => manager.list()
    );
    expect(handler({ ...event, sender: {} })).toEqual({ success: false, error: 'forbidden' });
    expect(handler({ ...event, senderFrame: {} })).toEqual({ success: false, error: 'forbidden' });
    expect(
      personalFilesHandler(
        () => null,
        () => manager.list()
      )(event)
    ).toEqual({ success: false, error: 'forbidden' });
    for (const input of [null, {}, '/../../etc/test.md', 'file:///profile.md'])
      expect(manager.read(input)).toEqual({ success: false, error: 'invalid_input' });
    expect(
      manager.restore({
        path: '/profile.md',
        generation: 1,
        revision: 1,
        expectedVersion: 'new',
        owner: 'other-owner',
      })
    ).toEqual({ success: false, error: 'invalid_input' });
    expect(
      new PersonalFilesManager(
        () => {
          throw new Error('must not open');
        },
        () => undefined
      ).list()
    ).toEqual({ success: false, error: 'unavailable' });
  });

  it('does not resurrect missing files or restore deletion markers; hides driver errors', () => {
    const { db, store, manager } = setup();
    const first = store.write('local-test', '/profile.md', 'fixture', 'new');
    const deleted = store.delete('local-test', '/profile.md', first.version);
    const request = {
      path: '/profile.md',
      generation: first.generation,
      revision: first.revision,
      expectedVersion: first.version,
    };
    expect(manager.restore(request)).toEqual({ success: false, error: 'version_conflict' });
    expect(manager.restore({ ...request, expectedVersion: 'new' })).toEqual({
      success: false,
      error: 'invalid_input',
    });
    expect(manager.restore({ ...request, revision: deleted.revision })).toEqual({
      success: false,
      error: 'invalid_input',
    });
    expect(manager.restore({ ...request, revision: 999 })).toEqual({
      success: false,
      error: 'not_found',
    });
    expect(manager.read('/profile.md')).toEqual({ success: false, error: 'not_found' });
    db.exec('DROP TABLE memory_files');
    expect(manager.list()).toEqual({ success: false, error: 'failed' });
  });
});
