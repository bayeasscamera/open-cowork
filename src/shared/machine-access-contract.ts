/**
 * @module shared/machine-access-contract
 *
 * The renderer/main contract for controlled machine access. Declared once and
 * imported by both sides so the preload surface cannot drift from the handlers.
 */

import type { AutonomyLevel, FolderGrant, GrantAccess, GrantScope } from '../main/machine-access/types';

export type { AutonomyLevel, FolderGrant };

export interface MachineAccessPermissionState {
  permission: 'accessibility' | 'screen-recording' | 'automation';
  granted: boolean;
  /**
   * False when macOS exposes no read-back for this permission (Automation).
   * The UI must then say "unknown", never "granted".
   */
  known: boolean;
  settingsUrl?: string;
  explanation: string;
}

export interface MachineAccessHistoryEntry {
  id: string;
  batchId: string;
  type: string;
  source: string;
  destination?: string;
  status: string;
  createdAt: number;
}

export interface MachineAccessState {
  /** False when the active execution mode is not native (WSL/Lima/SSH/Daytona). */
  nativeMode: boolean;
  grants: FolderGrant[];
  autonomy: AutonomyLevel;
  allowedApps: string[];
  permissions: MachineAccessPermissionState[];
  history: MachineAccessHistoryEntry[];
  backupQuotaBytes?: number;
  /** Bound accelerator, or null when another app already owns it. */
  emergencyShortcut: string | null;
  error?: string;
}

export interface MachineAccessPickFolderArgs {
  access?: GrantAccess;
  scope?: GrantScope;
  expiresAt?: number;
}

export interface MachineAccessBatchOp {
  type: 'move' | 'rename' | 'copy' | 'trash';
  src: string;
  dest?: string;
}

export interface MachineAccessBatchArgs {
  workspaceRoot: string;
  projectId: string;
  ops?: MachineAccessBatchOp[];
  allowGitRoots?: boolean;
}

export interface MachineAccessRenameArgs {
  projectId: string;
  newName: string;
  renameDir: boolean;
  newDirName?: string;
}
