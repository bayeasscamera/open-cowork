/**
 * Branch closure, round four: the system-trash path, the headless fallback and
 * the remaining listing caps in the fs tools.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry, type ToolContext } from '../src/main/tools/registry';
import { invokeTool } from '../src/main/tools/invoke';
import { buildFsTools } from '../src/main/machine-access/fs-tools';
import { FsJournal } from '../src/main/machine-access/fs-journal';
import { GrantStore } from '../src/main/machine-access/grant-store';

describe('fs trash paths', () => {
  let workspace: string;

  const build = (trashItem?: (p: string) => Promise<void>) => {
    const grants = new GrantStore(null);
    grants.addGrant({ path: workspace, access: 'read-write', scope: 'session' }, 'user');
    const journal = new FsJournal(null);
    const registry = new ToolRegistry();
    for (const tool of buildFsTools({
      workspaceRoot: workspace,
      grants,
      journal,
      backupRoot: path.join(workspace, '.b'),
      ...(trashItem ? { trashItem } : {}),
    })) {
      registry.register(tool);
    }
    return { registry, journal };
  };

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-tp-')));
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const call = async (registry: ToolRegistry, name: string, args: unknown) =>
    invokeTool(registry, name, args, { sessionId: 's', cwd: workspace } as ToolContext, {
      decidePermission: () => ({ allowed: true }),
    });

  it('uses the system trash when one is provided', async () => {
    const trashed: string[] = [];
    const { registry } = build(async (p) => {
      trashed.push(p);
      // Stand-in for the OS trash: the file leaves its original location.
      fs.renameSync(p, `${p}.in-trash`);
    });
    const f = path.join(workspace, 'a.txt');
    fs.writeFileSync(f, 'payload');
    const r = await call(registry, 'fs_trash', { path: f });
    expect(r.isError).toBeFalsy();
    expect(trashed).toEqual([f]);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('falls back to a Cowork-side move when no system trash exists', async () => {
    const { registry } = build(); // no trashItem
    const f = path.join(workspace, 'b.txt');
    fs.writeFileSync(f, 'payload');
    const r = await call(registry, 'fs_trash', { path: f });
    expect(r.isError).toBeFalsy();
    expect(fs.existsSync(f)).toBe(false);
    // The content is preserved next to the backup, never destroyed.
    const aside = fs
      .readdirSync(path.join(workspace, '.b'))
      .find((n) => n.endsWith('.trashed'));
    expect(aside).toBeTruthy();
    expect(fs.readFileSync(path.join(workspace, '.b', aside as string), 'utf-8')).toBe('payload');
  });

  it('reports a trash failure without throwing', async () => {
    const { registry } = build(async () => {
      throw new Error('trash unavailable');
    });
    const f = path.join(workspace, 'c.txt');
    fs.writeFileSync(f, 'payload');
    const r = await call(registry, 'fs_trash', { path: f });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('trash unavailable');
    // The original is untouched when the trash refuses.
    expect(fs.readFileSync(f, 'utf-8')).toBe('payload');
  });

  it('caps fs_list output and skips dotfiles in fs_search', async () => {
    const { registry } = build();
    for (let i = 0; i < 520; i += 1) {
      fs.writeFileSync(path.join(workspace, `f${String(i).padStart(4, '0')}.txt`), 'x');
    }
    fs.writeFileSync(path.join(workspace, '.hidden-secret.txt'), 'x');
    const listed = JSON.parse((await call(registry, 'fs_list', { path: workspace })).content) as Array<{
      name: string;
    }>;
    expect(listed.length).toBeLessThanOrEqual(500);

    const found = JSON.parse(
      (await call(registry, 'fs_search', { dir: workspace, pattern: 'hidden' })).content
    ) as string[];
    expect(found).toEqual([]);
  });

  it('fs_search stops at its result cap', async () => {
    const { registry } = build();
    const deep = path.join(workspace, 'deep');
    fs.mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 260; i += 1) {
      fs.writeFileSync(path.join(deep, `match-${String(i).padStart(4, '0')}.txt`), 'x');
    }
    const hits = JSON.parse(
      (await call(registry, 'fs_search', { dir: workspace, pattern: 'match-' })).content
    ) as string[];
    expect(hits.length).toBeLessThanOrEqual(200);
  });
});