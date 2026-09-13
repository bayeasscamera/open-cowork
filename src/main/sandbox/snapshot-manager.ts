/**
 * @module main/sandbox/snapshot-manager
 * v3.5: Instant Workspace Snapshots & One-Click Rollback (macOS APFS / Local Clone)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface WorkspaceSnapshot {
  id: string;
  workspacePath: string;
  timestamp: number;
  description: string;
  snapshotPath: string;
}

export class WorkspaceSnapshotManager {
  private snapshotsDir: string;
  private snapshots: Map<string, WorkspaceSnapshot> = new Map();

  constructor(appDataPath: string) {
    this.snapshotsDir = path.join(appDataPath, 'snapshots');
    if (!fs.existsSync(this.snapshotsDir)) {
      fs.mkdirSync(this.snapshotsDir, { recursive: true });
    }
  }

  public async createSnapshot(workspacePath: string, description: string): Promise<WorkspaceSnapshot> {
    const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const snapshotPath = path.join(this.snapshotsDir, id);

    if (process.platform === 'darwin') {
      // Use macOS cp -c (APFS Copy-on-Write clonefile: instant & takes 0 initial disk space)
      await execFileAsync('cp', ['-Rc', workspacePath, snapshotPath]);
    } else {
      await execFileAsync('cp', ['-R', workspacePath, snapshotPath]);
    }

    const snapshot: WorkspaceSnapshot = {
      id,
      workspacePath,
      timestamp: Date.now(),
      description,
      snapshotPath,
    };

    this.snapshots.set(id, snapshot);
    return snapshot;
  }

  public async rollbackSnapshot(snapshotId: string): Promise<boolean> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || !fs.existsSync(snapshot.snapshotPath)) {
      throw new Error(`Snapshot introuvable ou invalide: ${snapshotId}`);
    }

    // Restore workspace contents from snapshot
    if (process.platform === 'darwin') {
      await execFileAsync('rm', ['-rf', snapshot.workspacePath]);
      await execFileAsync('cp', ['-Rc', snapshot.snapshotPath, snapshot.workspacePath]);
    } else {
      await execFileAsync('rm', ['-rf', snapshot.workspacePath]);
      await execFileAsync('cp', ['-R', snapshot.snapshotPath, snapshot.workspacePath]);
    }

    return true;
  }

  public listSnapshots(workspacePath?: string): WorkspaceSnapshot[] {
    const list = Array.from(this.snapshots.values());
    if (workspacePath) {
      return list.filter((s) => s.workspacePath === workspacePath);
    }
    return list.sort((a, b) => b.timestamp - a.timestamp);
  }

  public async deleteSnapshot(snapshotId: string): Promise<boolean> {
    const snapshot = this.snapshots.get(snapshotId);
    if (snapshot && fs.existsSync(snapshot.snapshotPath)) {
      await execFileAsync('rm', ['-rf', snapshot.snapshotPath]);
      this.snapshots.delete(snapshotId);
      return true;
    }
    return false;
  }
}
