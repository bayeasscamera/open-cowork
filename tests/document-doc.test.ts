import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readWorkspaceDoc,
  writeWorkspaceDoc,
  listWorkspaceDocs,
} from '../src/main/documents/document-doc';

let cwd = '';

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cowork-doc-'));
  mkdirSync(join(cwd, 'dossier'), { recursive: true });
  writeFileSync(join(cwd, 'dossier-de-financement.md'), '# Dossier\nBudget : 12 500 EUR', 'utf-8');
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('document-doc — confined live co-editing', () => {
  it('reads a workspace document with its mtime', () => {
    const result = readWorkspaceDoc(cwd, 'dossier-de-financement.md');
    expect(result.ok).toBe(true);
    expect(result.content).toContain('12 500 EUR');
    expect(result.mtimeMs).toBeGreaterThan(0);
  });

  it('CONFINES reads and writes to the workspace (traversal refused)', () => {
    expect(readWorkspaceDoc(cwd, '../outside.md').ok).toBe(false);
    expect(readWorkspaceDoc(cwd, '/etc/hosts').ok).toBe(false);

    const write = writeWorkspaceDoc(cwd, '../escape.md', 'nope');
    expect(write.ok).toBe(false);
    expect(existsSync(join(cwd, '..', 'escape.md'))).toBe(false);
  });

  it('writes the user edit to disk (UI → agent via file)', () => {
    const path = 'dossier-de-financement.md';
    // Snapshot the file the way the editor panel does before saving.
    const snapshot = readWorkspaceDoc(cwd, path);
    const write = writeWorkspaceDoc(cwd, path, '# Dossier\nBudget : 20 000 EUR', {
      baseMtimeMs: snapshot.mtimeMs,
    });
    expect(write.status).toBe('written');
    expect(readWorkspaceDoc(cwd, path).content).toContain('20 000 EUR');
  });

  it('flags a CONFLICT when the agent modified the file after the editor snapshot', async () => {
    const path = 'dossier-de-financement.md';
    const first = readWorkspaceDoc(cwd, path);
    // The agent edits the file meanwhile (mtime moves forward).
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(cwd, path), '# Dossier\nVersion agent', 'utf-8');

    const write = writeWorkspaceDoc(cwd, path, 'Version utilisateur', {
      baseMtimeMs: (first.mtimeMs ?? 0) - 60_000,
    });
    expect(write.status).toBe('conflict'); // refused, not silently clobbered
    expect(readWorkspaceDoc(cwd, path).content).toContain('Version agent');

    // Explicit force overwrites after the user confirms.
    const forced = writeWorkspaceDoc(cwd, path, 'Version utilisateur', { force: true });
    expect(forced.status).toBe('written');
    expect(readWorkspaceDoc(cwd, path).content).toBe('Version utilisateur');
  });

  it('lists workspace markdown files, newest first', () => {
    const files = listWorkspaceDocs(cwd);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('dossier-de-financement.md');
    expect(paths).toContain(join('dossier', 'notes.md').replace(/\\/g, '/'));
  });
});

// listWorkspaceDocs only picks md/markdown/txt — seed an extra one for the list test.
beforeEach(() => {
  writeFileSync(join(cwd, 'dossier', 'notes.md'), 'notes', 'utf-8');
});