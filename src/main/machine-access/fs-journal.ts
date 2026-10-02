/**
 * @module main/machine-access/fs-journal
 *
 * Journal + undo for file mutations (spec 4.2). Table `fs_operations`:
 * id, batch_id, type, source, destination, backup_ref, checksum_before,
 * checksum_after, status, created_at.
 *
 * Undo never destroys: every reverse step first verifies the current state
 * matches what the journal expects; on divergence it reports and stops,
 * leaving user data intact.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { GrantDb } from './grant-store';

export type FsOpType = 'write' | 'create' | 'move' | 'rename' | 'copy' | 'trash' | 'organize';
export type FsOpStatus = 'done' | 'undone' | 'failed';

export interface FsOperation {
  id: string;
  batchId: string;
  type: FsOpType;
  source: string;
  destination?: string;
  backupRef?: string;
  checksumBefore?: string;
  checksumAfter?: string;
  status: FsOpStatus;
  createdAt: number;
}

export interface UndoResult {
  undone: string[];
  refused: Array<{ id: string; reason: string }>;
}

export function checksumString(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function checksumFile(filePath: string): string | undefined {
  try {
    return checksumString(fs.readFileSync(filePath));
  } catch {
    return undefined;
  }
}

/** Copy `src` into the Cowork trash/backup dir; returns the backup ref. */
export function backupFile(src: string, backupRoot: string, batchId: string): string {
  fs.mkdirSync(backupRoot, { recursive: true });
  const ref = path.join(backupRoot, `${batchId}-${randomUUID()}-${path.basename(src)}`);
  fs.copyFileSync(src, ref);
  return ref;
}

/** Enforce quota (bytes): purge oldest backups first. Returns removed refs. */
export function purgeBackups(backupRoot: string, quotaBytes: number): string[] {
  const removed: string[] = [];
  try {
    const entries = fs
      .readdirSync(backupRoot, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = path.join(backupRoot, e.name);
        return { full, mtime: fs.statSync(full).mtimeMs, size: fs.statSync(full).size };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const entry of entries) {
      if (total <= quotaBytes) break;
      fs.unlinkSync(entry.full);
      removed.push(entry.full);
      total -= entry.size;
    }
  } catch {
    // best effort
  }
  return removed;
}

export class FsJournal {
  private memory: FsOperation[] = [];
  constructor(private readonly db: GrantDb | null = null) {}

  record(op: Omit<FsOperation, 'id' | 'createdAt' | 'status'> & { status?: FsOpStatus }): FsOperation {
    const full: FsOperation = {
      id: randomUUID(),
      createdAt: Date.now(),
      status: 'done',
      ...op,
    };
    this.memory.push(full);
    try {
      this.db
        ?.prepare(
          'INSERT INTO fs_operations (id, batch_id, type, source, destination, backup_ref, checksum_before, checksum_after, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          full.id,
          full.batchId,
          full.type,
          full.source,
          full.destination ?? null,
          full.backupRef ?? null,
          full.checksumBefore ?? null,
          full.checksumAfter ?? null,
          full.status,
          full.createdAt
        );
    } catch {
      // best effort
    }
    return full;
  }

  history(batchId?: string): FsOperation[] {
    return batchId ? this.memory.filter((op) => op.batchId === batchId) : [...this.memory];
  }

  private mark(id: string, status: FsOpStatus): void {
    const op = this.memory.find((o) => o.id === id);
    if (op) op.status = status;
    try {
      this.db?.prepare('UPDATE fs_operations SET status = ? WHERE id = ?').run(status, id);
    } catch {
      // ignore
    }
  }

  /**
   * Undo one batch, newest first. Verifies current state before touching
   * anything; refuses cleanly on divergence.
   */
  undoBatch(batchId: string): UndoResult {
    const ops = this.history(batchId).reverse();
    const result: UndoResult = { undone: [], refused: [] };
    for (const op of ops) {
      if (op.status === 'undone') continue;
      const refusal = this.undoOne(op);
      if (refusal) result.refused.push({ id: op.id, reason: refusal });
      else {
        this.mark(op.id, 'undone');
        result.undone.push(op.id);
      }
    }
    return result;
  }

  private undoOne(op: FsOperation): string | null {
    try {
      switch (op.type) {
        case 'write':
        case 'create': {
          // Restore the pre-overwrite backup; `create` has no backup (file did not exist).
          if (!op.backupRef || !fs.existsSync(op.backupRef)) {
            if (op.type === 'create') {
              if (!fs.existsSync(op.source)) return null; // already gone
              if (op.checksumAfter && checksumFile(op.source) !== op.checksumAfter) {
                return 'file changed since creation; will not delete user data';
              }
              this.moveToCoworkTrash(op.source);
              return null;
            }
            return 'backup missing; nothing restored';
          }
          if (fs.existsSync(op.source) && op.checksumAfter && checksumFile(op.source) !== op.checksumAfter) {
            return 'file changed since the operation; will not overwrite user data';
          }
          fs.copyFileSync(op.backupRef, op.source);
          return null;
        }
        case 'move':
        case 'rename': {
          const dest = op.destination ?? '';
          const src = op.source;
          if (!dest || !fs.existsSync(dest)) return 'destination missing; nothing to move back';
          if (fs.existsSync(src)) return 'original path re-occupied; will not overwrite';
          fs.renameSync(dest, src);
          return null;
        }
        case 'copy': {
          const dest = op.destination ?? '';
          if (!fs.existsSync(dest)) return null;
          if (op.checksumAfter && checksumFile(dest) !== op.checksumAfter) {
            return 'copy changed since; will not delete user data';
          }
          this.moveToCoworkTrash(dest);
          return null;
        }
        case 'trash': {
          if (!op.backupRef || !fs.existsSync(op.backupRef)) return 'trash backup missing';
          if (fs.existsSync(op.source)) return 'a file now exists at the trashed path; will not overwrite';
          fs.copyFileSync(op.backupRef, op.source);
          return null;
        }
        case 'organize':
          return 'organize batches undo member-by-member; use undoBatch on the member batch';
        default:
          return `unknown operation type`;
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private moveToCoworkTrash(target: string): void {
    try {
      const dir = path.join(path.dirname(target), '.cowork-trash');
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(target, path.join(dir, `${Date.now()}-${path.basename(target)}`));
    } catch {
      // last resort: leave the file in place rather than delete it
    }
  }
}
