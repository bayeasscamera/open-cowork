import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Type } from '@sinclair/typebox';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MemoryFilesStore } from '../src/main/memory/memory-files-store';
import { createMemoryFileTools } from '../src/main/memory/memory-files-tools';
import type { AgentRuntimeCustomTool } from '../src/main/extensions/agent-runtime-extension';

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const legacyRead: AgentRuntimeCustomTool = {
  name: 'memory_read',
  label: 'memory_read',
  description: 'legacy',
  parameters: Type.Object({ id: Type.String() }),
  execute: vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'legacy details' }],
    details: undefined,
  })),
};
async function call(tools: AgentRuntimeCustomTool[], name: string, params: unknown) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  const output = await tool.execute('test-call', params, undefined, undefined, {} as never);
  return JSON.parse((output.content[0] as { text: string }).text);
}
function setup(confirmDelete?: (id: string, path: string, version: string) => Promise<boolean>) {
  const db = new Database(':memory:');
  databases.push(db);
  const store = new MemoryFilesStore(db);
  let enabled = true;
  const tools = createMemoryFileTools({
    store,
    owner: 'local-installation',
    sessionId: 'session',
    isEnabled: () => enabled,
    legacyRead,
    confirmDelete,
  });
  return {
    store,
    tools,
    disable: () => {
      enabled = false;
    },
  };
}

describe('versioned memory tools with the real SQLite store', () => {
  it('registers all six uniquely and supports the legacy read id contract', async () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual([
      'memory_list',
      'memory_read',
      'memory_write',
      'memory_append',
      'memory_str_replace',
      'memory_delete',
    ]);
    const read = tools.find((tool) => tool.name === 'memory_read');
    expect(
      (await read?.execute('legacy', { id: 'core:test' }, undefined, undefined, {} as never))
        ?.content
    ).toEqual([{ type: 'text', text: 'legacy details' }]);
    expect(await call(tools, 'memory_read', { id: 'core:test', path: '/profile.md' })).toEqual({
      error: 'invalid_params',
    });
  });

  it('rejects model-selected owners/sources and stale tools after disabling memory', async () => {
    const { store, tools, disable } = setup();
    expect(
      await call(tools, 'memory_write', {
        owner: 'other',
        path: '/profile.md',
        content: 'x',
        if_version: 'new',
      })
    ).toEqual({ error: 'invalid_params' });
    expect(
      await call(tools, 'memory_write', {
        sources: ['forged'],
        path: '/profile.md',
        content: 'x',
        if_version: 'new',
      })
    ).toEqual({ error: 'invalid_params' });
    await call(tools, 'memory_write', {
      path: '/profile.md',
      content: 'durable',
      if_version: 'new',
    });
    expect(store.list('other')).toEqual([]);
    disable();
    for (const tool of tools)
      expect(await call(tools, tool.name, {})).toEqual({ error: 'memory_disabled' });
    expect(store.list('local-installation')).toHaveLength(1);
  });

  it('fails closed on missing, denied or throwing confirmation, regardless of model booleans', async () => {
    for (const confirmation of [
      undefined,
      async () => false,
      async () => {
        throw new Error('offline');
      },
    ]) {
      const { tools } = setup(confirmation);
      const file = await call(tools, 'memory_write', {
        path: '/profile.md',
        content: 'durable',
        if_version: 'new',
      });
      const denied = await call(tools, 'memory_delete', {
        path: '/profile.md',
        if_version: file.version,
      });
      expect(denied.error).toBeTruthy();
      expect((await call(tools, 'memory_list', {})).files).toHaveLength(1);
      expect(
        await call(tools, 'memory_delete', {
          path: '/profile.md',
          if_version: file.version,
          confirmed: true,
        })
      ).toEqual({ error: 'invalid_params' });
    }
  });

  it('checks version after consent and returns the conflicting content/version', async () => {
    const approval = vi.fn(async () => {
      await call(tools, 'memory_write', {
        path: '/profile.md',
        content: 'changed during approval',
        if_version: first.version,
      });
      return true;
    });
    const { tools } = setup(approval);
    const first = await call(tools, 'memory_write', {
      path: '/profile.md',
      content: 'initial',
      if_version: 'new',
    });
    const conflict = await call(tools, 'memory_delete', {
      path: '/profile.md',
      if_version: first.version,
    });
    expect(conflict.error).toBe('version_conflict');
    expect(conflict.current_content).toBe('changed during approval');
    expect(conflict.current_version).not.toBe(first.version);
    expect(approval).toHaveBeenCalledWith('test-call', '/profile.md', first.version);
  });

  it('does not delete when disabled during approval', async () => {
    const { tools, disable } = setup(async () => {
      disable();
      return true;
    });
    const file = await call(tools, 'memory_write', {
      path: '/profile.md',
      content: 'keep',
      if_version: 'new',
    });
    expect(
      await call(tools, 'memory_delete', { path: '/profile.md', if_version: file.version })
    ).toEqual({ error: 'memory_disabled' });
  });

  it('persists creation/update across actual child-process restart, then requires fresh explicit consent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cowork-memory-profile-'));
    directories.push(dir);
    const databasePath = join(dir, 'cowork.sqlite');
    // Transpile only the two source modules on demand in the test child. No app
    // build, install, Electron launch, or native ABI changes are performed.
    const bootstrap = `
      const fs = require('node:fs');
      const ts = require('typescript');
      require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, filename);
      const Database = require('better-sqlite3');
      const {MemoryFilesStore} = require(${JSON.stringify(resolve('src/main/memory/memory-files-store.ts'))});
      const {createMemoryFileTools} = require(${JSON.stringify(resolve('src/main/memory/memory-files-tools.ts'))});
      const db = new Database(${JSON.stringify(databasePath)});
      const store = new MemoryFilesStore(db);
      let consent = false, confirmations = 0;
      const tools = createMemoryFileTools({store,owner:'local-installation',sessionId:'s',isEnabled:()=>true,legacyRead:{},confirmDelete:async()=>{confirmations++;return consent;}});
      const call = async(name,params)=>JSON.parse((await tools.find(t=>t.name===name).execute('id',params)).content[0].text);
    `;
    const run = (script: string) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            '-e',
            `${bootstrap}\n(async()=>{try{${script}}finally{db.close();}})().catch(()=>process.exit(1));`,
          ],
          { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 }
        )
      );
    const created = run(`
      const first=await call('memory_write',{path:'/profile.md',content:'first durable fact',if_version:'new'});
      const updated=await call('memory_write',{path:'/profile.md',content:'updated durable fact',if_version:first.version});
      process.stdout.write(JSON.stringify({first,updated}));
    `);
    expect(created.updated.version).not.toBe(created.first.version);
    const reopened = run(`
      const read=await call('memory_read',{path:'/profile.md'});
      const version=${JSON.stringify(created.updated.version)};
      const denied=await call('memory_delete',{path:'/profile.md',if_version:version});
      const retained=store.list('local-installation').length;
      consent=true;
      const deleted=await call('memory_delete',{path:'/profile.md',if_version:version});
      process.stdout.write(JSON.stringify({read,denied,retained,deleted,remaining:store.list('local-installation').length,confirmations}));
    `);
    expect(JSON.stringify(reopened.read)).toContain('updated durable fact');
    expect(JSON.stringify(reopened.read)).toContain(created.updated.version);
    expect(reopened.denied.error).toBe('confirmation_denied');
    expect(reopened.retained).toBe(1);
    expect(reopened.remaining).toBe(0);
    expect(reopened.confirmations).toBe(2);
  });
});
