/**
 * @module main/machine-access/fs-tools
 *
 * File tools (spec 4) registered on the single tool registry and executed
 * through the single `invokeTool()` entry point. Every mutating tool:
 * resolves with resolveSafePath, requires an approval card for sensitive or
 * risky actions (returned as an `approvalRequired` error payload — the tool
 * never self-approves), writes the journal, and never deletes permanently:
 * trash always goes through the system trash (or a Cowork backup when the
 * trash is unavailable) with a restorable backup ref.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ToolDefinition, ToolRegistry, ToolResult } from '../tools/registry';
import { resolveSafePath } from './safe-path';
import { assessRisk } from './risk-assessor';
import { isSecretFilename } from './sensitive-zones';
import { backupFile, checksumFile, FsJournal } from './fs-journal';
import { GrantStore } from './grant-store';

export interface FsToolsDeps {
  workspaceRoot: string;
  grants: GrantStore;
  journal: FsJournal;
  /** Where Cowork keeps overwrite/trash backups (quota + purge). */
  backupRoot: string;
  /** Electron shell.trashItem when running in Electron; absent in tests. */
  trashItem?: (filePath: string) => Promise<void>;
  projectId?: string;
  maxReadBytes?: number;
}

type Schema = ToolDefinition['inputSchema'];
const schema = (properties: Record<string, unknown>, required: string[] = []): Schema =>
  ({ type: 'object', properties, required }) as unknown as Schema;

function approvalNeeded(content: string, details: unknown): ToolResult {
  return { content, isError: true, details: { approvalRequired: true, ...(details as object) } };
}

function grantRefusal(realPath: string): ToolResult {
  return {
    content: `Access refused: '${realPath}' is outside the granted folders. Ask the user to grant access (native folder picker) instead of working around it.`,
    isError: true,
    details: { needsGrant: true, path: realPath },
  };
}

function ctx(deps: FsToolsDeps) {
  return {
    resolveForWrite: (input: string) =>
      resolveSafePath(input, {
        workspaceRoot: deps.workspaceRoot,
        grants: deps.grants.list(),
        needsWrite: true,
      }),
    resolveForRead: (input: string) =>
      resolveSafePath(input, {
        workspaceRoot: deps.workspaceRoot,
        grants: deps.grants.list(),
        needsWrite: false,
      }),
  };
}

function isBinaryLike(sample: Buffer): boolean {
  return sample.includes(0);
}

export function buildFsTools(deps: FsToolsDeps): ToolDefinition[] {
  const { resolveForWrite, resolveForRead } = ctx(deps);
  const maxRead = deps.maxReadBytes ?? 512 * 1024;

  const fsList: ToolDefinition = {
    name: 'fs_list',
    description: 'List a granted directory. Read-only.',
    inputSchema: schema({ path: { type: 'string' } }, ['path']),
    risk: 'read',
    execute: async (args) => {
      const target = (args as { path?: unknown }).path;
      if (typeof target !== 'string') return { content: 'fs_list needs `path`.', isError: true };
      const r = resolveForRead(target);
      if (!r.ok) return r.needsGrant === true && r.realPath ? grantRefusal(r.realPath) : { content: r.error ?? 'refused', isError: true };
      try {
        const entries = fs.readdirSync(r.realPath ?? '', { withFileTypes: true }).map((e) => ({
          name: e.name,
          dir: e.isDirectory(),
        }));
        return { content: JSON.stringify(entries.slice(0, 500)) };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };

  const fsSearch: ToolDefinition = {
    name: 'fs_search',
    description: 'Search filenames under a granted directory. Read-only.',
    inputSchema: schema({ dir: { type: 'string' }, pattern: { type: 'string' } }, ['dir', 'pattern']),
    risk: 'read',
    execute: async (args) => {
      const { dir, pattern } = args as { dir?: unknown; pattern?: unknown };
      if (typeof dir !== 'string' || typeof pattern !== 'string') {
        return { content: 'fs_search needs `dir` and `pattern`.', isError: true };
      }
      const r = resolveForRead(dir);
      if (!r.ok) return r.needsGrant === true && r.realPath ? grantRefusal(r.realPath) : { content: r.error ?? 'refused', isError: true };
      const root = r.realPath ?? '';
      const hits: string[] = [];
      const walk = (current: string): void => {
        if (hits.length >= 200) return;
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(current, entry.name);
          if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
            hits.push(full);
            if (hits.length >= 200) return;
          }
          if (entry.isDirectory()) walk(full);
        }
      };
      walk(root);
      return { content: JSON.stringify(hits) };
    },
  };

  const fsRead: ToolDefinition = {
    name: 'fs_read',
    description: 'Read a granted file. Secrets are masked unless explicitly approved.',
    inputSchema: schema({ path: { type: 'string' } }, ['path']),
    risk: 'read',
    execute: async (args) => {
      const target = (args as { path?: unknown }).path;
      if (typeof target !== 'string') return { content: 'fs_read needs `path`.', isError: true };
      const r = resolveForRead(target);
      if (!r.ok) return r.needsGrant === true && r.realPath ? grantRefusal(r.realPath) : { content: r.error ?? 'refused', isError: true };
      const real = r.realPath ?? '';
      if (isSecretFilename(path.basename(real))) {
        const assessment = assessRisk({ kind: 'fs-read', paths: [real], readsSecrets: true });
        if (assessment.level !== 'ordinaire' || r.sensitive === true) {
          return approvalNeeded(
            `Reading '${real}' touches secret material and needs explicit user approval (content masked).`,
            { path: real, reasons: assessment.reasons }
          );
        }
      }
      try {
        const stat = fs.statSync(real);
        if (stat.isDirectory()) return { content: `'${real}' is a directory; use fs_list.`, isError: true };
        const fd = fs.openSync(real, 'r');
        try {
          const size = Math.min(stat.size, maxRead);
          const buffer = Buffer.alloc(Math.max(size, 0));
          fs.readSync(fd, buffer, 0, size, 0);
          if (isBinaryLike(buffer.subarray(0, Math.min(size, 8000)))) {
            return { content: `Binary file (${stat.size} bytes); refusing text read.`, isError: true };
          }
          const truncated = stat.size > maxRead ? `\n…[truncated ${stat.size - maxRead} bytes]` : '';
          return { content: buffer.toString('utf-8') + truncated };
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };

  const fsWrite: ToolDefinition = {
    name: 'fs_write',
    description: 'Create or overwrite a file in a granted folder. Existing files are backed up first.',
    inputSchema: schema({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    risk: 'write',
    execute: async (args) => {
      const { path: target, content } = args as { path?: unknown; content?: unknown };
      if (typeof target !== 'string' || typeof content !== 'string') {
        return { content: 'fs_write needs `path` and `content`.', isError: true };
      }
      const r = resolveForWrite(target);
      if (!r.ok) return r.needsGrant === true && r.realPath ? grantRefusal(r.realPath) : { content: r.error ?? 'refused', isError: true };
      const real = r.realPath ?? '';
      if (r.sensitive === true) {
        return approvalNeeded(`Writing '${real}' touches a sensitive zone and needs approval.`, { path: real });
      }
      try {
        const batchId = randomUUID();
        const existed = fs.existsSync(real);
        const before = existed ? checksumFile(real) : undefined;
        let backupRef: string | undefined;
        if (existed) backupRef = backupFile(real, deps.backupRoot, batchId);
        else fs.mkdirSync(path.dirname(real), { recursive: true });
        fs.writeFileSync(real, content, 'utf-8');
        const op = deps.journal.record({
          batchId,
          type: existed ? 'write' : 'create',
          source: real,
          ...(backupRef ? { backupRef } : {}),
          ...(before ? { checksumBefore: before } : {}),
          checksumAfter: checksumFile(real),
        });
        return { content: JSON.stringify({ ok: true, opId: op.id, batchId, backup: Boolean(backupRef) }) };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };

  const fsCreate: ToolDefinition = {
    name: 'fs_create',
    description: 'Create a new file; refuses when the file already exists.',
    inputSchema: schema({ path: { type: 'string' }, content: { type: 'string' } }, ['path']),
    risk: 'write',
    execute: async (args) => {
      const { path: target, content } = args as { path?: unknown; content?: unknown };
      if (typeof target !== 'string') return { content: 'fs_create needs `path`.', isError: true };
      const r = resolveForWrite(target);
      if (!r.ok) return r.needsGrant === true && r.realPath ? grantRefusal(r.realPath) : { content: r.error ?? 'refused', isError: true };
      const real = r.realPath ?? '';
      if (r.sensitive === true) return approvalNeeded(`Creating '${real}' touches a sensitive zone.`, { path: real });
      if (fs.existsSync(real)) return { content: `'${real}' already exists; use fs_write to overwrite (backed up).`, isError: true };
      try {
        fs.mkdirSync(path.dirname(real), { recursive: true });
        fs.writeFileSync(real, typeof content === 'string' ? content : '', 'utf-8');
        const batchId = randomUUID();
        const op = deps.journal.record({ batchId, type: 'create', source: real, checksumAfter: checksumFile(real) });
        return { content: JSON.stringify({ ok: true, opId: op.id, batchId }) };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };

  const moveLike = (
    name: 'fs_move' | 'fs_rename' | 'fs_copy',
    copy: boolean
  ): ToolDefinition => ({
    name,
    description: copy ? 'Copy a file.' : 'Move/rename a file. Refuses to overwrite without approval.',
    inputSchema: schema(
      { src: { type: 'string' }, dest: { type: 'string' }, overwrite: { type: 'boolean' } },
      ['src', 'dest']
    ),
    risk: 'write',
    execute: async (args) => {
      const { src, dest, overwrite } = args as { src?: unknown; dest?: unknown; overwrite?: unknown };
      if (typeof src !== 'string' || typeof dest !== 'string') {
        return { content: `${name} needs \`src\` and \`dest\`.`, isError: true };
      }
      const rs = resolveForWrite(src);
      if (!rs.ok) return rs.needsGrant === true && rs.realPath ? grantRefusal(rs.realPath) : { content: rs.error ?? 'refused', isError: true };
      const rd = resolveForWrite(dest);
      if (!rd.ok) return rd.needsGrant === true && rd.realPath ? grantRefusal(rd.realPath) : { content: rd.error ?? 'refused', isError: true };
      const s = rs.realPath ?? '';
      const d = rd.realPath ?? '';
      if ((rs.sensitive ?? false) || (rd.sensitive ?? false)) {
        return approvalNeeded(`${name} touches a sensitive zone and needs approval.`, { src: s, dest: d });
      }
      if (!fs.existsSync(s)) return { content: `Source not found: '${s}'.`, isError: true };
      if (fs.existsSync(d) && overwrite !== true) {
        return { content: `Destination exists: '${d}'. Pass overwrite:true with user approval.`, isError: true };
      }
      try {
        const batchId = randomUUID();
        const before = checksumFile(s);
        fs.mkdirSync(path.dirname(d), { recursive: true });
        if (copy) fs.copyFileSync(s, d);
        else fs.renameSync(s, d);
        const op = deps.journal.record({
          batchId,
          type: copy ? 'copy' : name === 'fs_rename' ? 'rename' : 'move',
          source: s,
          destination: d,
          ...(before ? { checksumBefore: before } : {}),
          checksumAfter: checksumFile(d),
        });
        return { content: JSON.stringify({ ok: true, opId: op.id, batchId }) };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  });

  const fsTrash: ToolDefinition = {
    name: 'fs_trash',
    description: 'Send a file to the system trash (never permanently deleted). Replaces all deletion.',
    inputSchema: schema({ path: { type: 'string' } }, ['path']),
    risk: 'write',
    execute: async (args) => {
      const target = (args as { path?: unknown }).path;
      if (typeof target !== 'string') return { content: 'fs_trash needs `path`.', isError: true };
      const r = resolveForWrite(target);
      if (!r.ok) return r.needsGrant === true && r.realPath ? grantRefusal(r.realPath) : { content: r.error ?? 'refused', isError: true };
      const real = r.realPath ?? '';
      if (r.sensitive === true) {
        return approvalNeeded(`Trashing '${real}' touches a sensitive zone and needs approval.`, { path: real });
      }
      if (!fs.existsSync(real)) return { content: `Not found: '${real}'.`, isError: true };
      try {
        const batchId = randomUUID();
        const before = checksumFile(real);
        const backupRef = backupFile(real, deps.backupRoot, batchId);
        if (deps.trashItem) await deps.trashItem(real);
        else {
          // No system trash available (tests/headless): keep the backup and
          // move the original aside — never unlink permanently.
          const aside = `${backupRef}.trashed`;
          fs.renameSync(real, aside);
        }
        const op = deps.journal.record({
          batchId,
          type: 'trash',
          source: real,
          backupRef,
          ...(before ? { checksumBefore: before } : {}),
        });
        return { content: JSON.stringify({ ok: true, opId: op.id, batchId, backup: true }) };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };

  return [fsList, fsSearch, fsRead, fsWrite, fsCreate, moveLike('fs_move', false), moveLike('fs_rename', false), moveLike('fs_copy', true), fsTrash];
}

export function registerMachineAccessTools(registry: ToolRegistry, deps: FsToolsDeps): string[] {
  const tools = buildFsTools(deps);
  for (const tool of tools) {
    if (!registry.has(tool.name)) registry.register(tool);
  }
  return tools.map((t) => t.name);
}
