/**
 * SandboxSync - Manages file synchronization between Windows and WSL sandbox
 *
 * This module provides complete isolation by:
 * 1. Copying files from Windows to an isolated WSL directory (~/.claude/sandbox/{sessionId})
 * 2. Running all operations within the isolated directory
 * 3. Syncing changes back to Windows when requested
 *
 * Lifecycle:
 * - Sandbox is created when a conversation starts (first message)
 * - Sandbox persists across multiple messages in the same conversation
 * - Sandbox is deleted when:
 *   - User deletes the conversation
 *   - App is closed/shutdown
 *
 * The registry and the sync/cleanup sequence live in SandboxVmSync; this file
 * only supplies the WSL transport, the Windows path mapping and the log prefix.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from '../utils/logger';
import { pathConverter } from './wsl-bridge';
import { isPathWithinRoot } from '../tools/path-containment';
import { validateSessionId } from './sync-helpers';
import {
  SandboxVmSync,
  type VmSyncResult,
  type VmSyncSession,
  type VmSyncSessionInit,
} from './sandbox-vm-sync';

const execFileAsync = promisify(execFile);

/** Validate WSL distro name to prevent command injection */
function validateDistroName(distro: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(distro)) {
    throw new Error(`Invalid distro name: ${distro}`);
  }
}

export interface SyncSession extends VmSyncSession {
  windowsPath: string; // Original Windows path (e.g. D:/project)
  distro: string; // WSL distro name
}

export type SyncResult = VmSyncResult;

export class SandboxSync extends SandboxVmSync {
  /** WSL sessions live in their own registry, shadowing the base declaration. */
  protected static override sessions: Map<string, VmSyncSession> = new Map();

  protected static override get logPrefix(): string {
    return '[SandboxSync]';
  }

  protected static override get fallbackHome(): string {
    return '/root';
  }

  /** WSL syncs in cleanupAllSessions(); cleanup() itself only deletes. */
  protected static override get syncsBeforeCleanup(): boolean {
    return true;
  }

  protected static override validateContext(context?: unknown): void {
    validateDistroName(context as string);
  }

  protected static override execCommand(
    command: string,
    timeout: number,
    context?: unknown
  ): Promise<{ stdout: string; stderr: string }> {
    return this.wslExec(context as string, command, timeout);
  }

  /** WSL sees the Windows drive under /mnt, so host paths must be converted. */
  protected static override toVmPath(hostPath: string): string {
    return pathConverter.toWSL(hostPath);
  }

  protected static override hostPathOf(session: VmSyncSession): string {
    return (session as SyncSession).windowsPath;
  }

  protected static override contextOf(session: VmSyncSession): unknown {
    return (session as SyncSession).distro;
  }

  protected static override buildSession(init: VmSyncSessionInit): SyncSession {
    return {
      sessionId: init.sessionId,
      windowsPath: init.hostPath,
      sandboxPath: init.sandboxPath,
      distro: init.context as string,
      initialized: true,
      fileCount: init.fileCount,
      totalSize: init.totalSize,
      lastSyncTime: Date.now(),
    };
  }

  /**
   * Initialize a new sync session or return existing one
   * Copies files from Windows to WSL sandbox (only on first init)
   */
  static initSync(windowsPath: string, sessionId: string, distro: string): Promise<SyncResult> {
    return this.initSyncCore(windowsPath, sessionId, distro);
  }

  /**
   * Sync changes from sandbox back to Windows (without cleanup)
   * Called after each message to persist changes while keeping sandbox alive
   */
  static async syncToWindows(sessionId: string): Promise<SyncResult> {
    return this.syncToHost(sessionId);
  }

  /**
   * Sync changes from sandbox back to Windows (legacy alias for syncToWindows)
   * @deprecated Use syncToWindows instead
   */
  static async finalSync(sessionId: string): Promise<SyncResult> {
    return this.syncToWindows(sessionId);
  }

  /**
   * Sync to Windows and then cleanup the sandbox
   * Called when a session/conversation is deleted
   */
  static async syncAndCleanup(sessionId: string): Promise<SyncResult> {
    validateSessionId(sessionId);
    log(`[SandboxSync] Sync and cleanup for session ${sessionId}`);

    // First sync changes back to Windows
    const syncResult = await this.syncToWindows(sessionId);

    // Then cleanup the sandbox
    await this.cleanup(sessionId);

    return syncResult;
  }

  /** Get session info (narrowed to the WSL session shape) */
  static override getSession(sessionId: string): SyncSession | undefined {
    return this.sessions.get(sessionId) as SyncSession | undefined;
  }

  /** Get the distro for a session (if initialized) */
  static getDistro(sessionId: string): string | null {
    return this.getSession(sessionId)?.distro || null;
  }

  /**
   * Convert a Windows path to its sandbox equivalent
   */
  static windowsToSandboxPath(windowsPath: string, sessionId: string): string | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    // Normalize paths
    const normalizedWindows = session.windowsPath.replace(/\\/g, '/').toLowerCase();
    const normalizedInput = windowsPath.replace(/\\/g, '/').toLowerCase();

    if (isPathWithinRoot(normalizedInput, normalizedWindows, true)) {
      const relativePath = windowsPath.substring(session.windowsPath.length);
      return session.sandboxPath + relativePath.replace(/\\/g, '/');
    }

    return null;
  }

  /**
   * Convert a sandbox path to its Windows equivalent
   */
  static sandboxToWindowsPath(sandboxPath: string, sessionId: string): string | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    if (isPathWithinRoot(sandboxPath, session.sandboxPath)) {
      const relativePath = sandboxPath.substring(session.sandboxPath.length);
      return session.windowsPath + relativePath.replace(/\//g, '\\');
    }

    return null;
  }

  /**
   * Execute a command in WSL (async, captures both stdout and stderr)
   */
  private static async wslExec(
    distro: string,
    command: string,
    timeout = 60000
  ): Promise<{ stdout: string; stderr: string }> {
    const bashScript = `source ~/.nvm/nvm.sh 2>/dev/null; ${command}`;
    const result = await execFileAsync('wsl', ['-d', distro, '-e', 'bash', '-c', bashScript], {
      timeout,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.stderr) {
      log(`[SandboxSync] wslExec stderr: ${result.stderr.substring(0, 500)}`);
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * Format bytes to human readable string
   */
  protected static override formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}

export default SandboxSync;
