/**
 * SandboxVmSync - shared lifecycle for host <-> VM sandbox file synchronization.
 *
 * SandboxSync (WSL) and LimaSync (Lima) keep the same registry of live sandboxes
 * and run the same copy / rsync / cleanup sequence against a VM. This base class
 * owns that registry and that sequence; subclasses supply the VM transport, the
 * path mapping and a handful of naming hooks.
 *
 * Every member is static and each subclass shadows `sessions` with its own map,
 * so `this` inside these methods resolves to the concrete class being called.
 */

import { log, logError } from '../utils/logger';
import { isPathWithinRoot } from '../tools/path-containment';
import {
  buildCopyCommand,
  buildRsyncCommand,
  isRealPathWithinSandboxRoot,
  sandboxRootOf,
  shellEscapePath,
  validateSessionId,
} from './sync-helpers';

/** Fields shared by every sandbox session registry entry. */
export interface VmSyncSession {
  sessionId: string;
  sandboxPath: string;
  initialized: boolean;
  fileCount?: number;
  totalSize?: number;
  lastSyncTime?: number;
}

export interface VmSyncResult {
  success: boolean;
  sandboxPath: string;
  fileCount: number;
  totalSize: number;
  error?: string;
}

export interface VmSyncFileResult {
  success: boolean;
  sandboxPath: string;
  error?: string;
}

/** Input handed to `buildSession()` so each backend shapes its own record. */
export interface VmSyncSessionInit {
  sessionId: string;
  hostPath: string;
  sandboxPath: string;
  context?: unknown;
  fileCount: number;
  totalSize: number;
}

export abstract class SandboxVmSync {
  /** Live sandbox registry. Every subclass shadows this with its own map. */
  protected static sessions: Map<string, VmSyncSession> = new Map();

  // ── Hooks implemented by each VM backend ────────────────────────────────

  /** Prefix used by every log line, e.g. "[SandboxSync]". */
  protected static get logPrefix(): string {
    return '[SandboxVmSync]';
  }

  /** Home directory assumed when `cd ~ && pwd` returns nothing. */
  protected static get fallbackHome(): string {
    return '/root';
  }

  /** Whether `cleanupAllSessions()` syncs before delegating to `cleanup()`. */
  protected static get syncsBeforeCleanup(): boolean {
    return false;
  }

  /** Whether `cleanup()` syncs the session back to the host before deleting it. */
  protected static get cleanupSyncsFirst(): boolean {
    return false;
  }

  /** Whether a failed cleanup still drops the session from the registry. */
  protected static get dropsSessionOnCleanupError(): boolean {
    return false;
  }

  /** Validate the VM context (e.g. a WSL distro name) before any command runs. */
  protected static validateContext(_context?: unknown): void {}

  /** Run a shell command inside the VM. */
  protected static execCommand(
    _command: string,
    _timeout: number,
    _context?: unknown
  ): Promise<{ stdout: string; stderr: string }> {
    return Promise.reject(new Error('execCommand() must be implemented by the VM sync subclass'));
  }

  /** Rewrite a host path into the path namespace visible inside the VM. */
  protected static toVmPath(hostPath: string): string {
    return hostPath;
  }

  /** Host-native path recorded for a session. */
  protected static hostPathOf(_session: VmSyncSession): string {
    throw new Error('hostPathOf() must be implemented by the VM sync subclass');
  }

  /** VM context needed to reach a session's VM (e.g. its WSL distro). */
  protected static contextOf(_session: VmSyncSession): unknown {
    return undefined;
  }

  /** Build the concrete session record persisted in the registry. */
  protected static buildSession(_init: VmSyncSessionInit): VmSyncSession {
    throw new Error('buildSession() must be implemented by the VM sync subclass');
  }

  /** Human-readable byte size (each backend formats differently on purpose). */
  protected static formatSize(bytes: number): string {
    return String(bytes);
  }

  // ── Registry ────────────────────────────────────────────────────────────

  /** Check if a sandbox session already exists for the given session ID. */
  static hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Get all active session IDs. */
  static getAllSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Get the sandbox path for a session (if initialized). */
  static getSandboxPath(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.sandboxPath ?? null;
  }

  /** Get session info. */
  static getSession(sessionId: string): VmSyncSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Check if a path is within the sandbox. */
  static isPathInSandbox(path: string, sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return isPathWithinRoot(path, session.sandboxPath);
  }

  /** Clear all session mappings without syncing or cleanup. */
  static clearAllSessions(): void {
    const count = this.sessions.size;
    if (count === 0) {
      log(`${this.logPrefix} No sessions to clear`);
      return;
    }
    this.sessions.clear();
    log(`${this.logPrefix} Cleared ${count} session(s) from map`);
  }

  /** Clear a specific session mapping without syncing or cleanup. */
  static clearSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      log(`${this.logPrefix} Cleared session ${sessionId} from map`);
    }
  }

  // ── Sync lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialize a new sync session or return the existing one.
   * Copies files from the host into the VM sandbox on first init only.
   */
  protected static async initSyncCore(
    hostPath: string,
    sessionId: string,
    context?: unknown
  ): Promise<VmSyncResult> {
    validateSessionId(sessionId);
    this.validateContext(context);

    // The sandbox persists across messages: reuse it while it still exists
    const existingSession = this.sessions.get(sessionId);
    if (existingSession && existingSession.initialized) {
      log(`${this.logPrefix} Reusing existing sandbox for session ${sessionId}`);
      log(`${this.logPrefix}   Sandbox path: ${existingSession.sandboxPath}`);

      try {
        await this.execCommand(
          `test -d '${shellEscapePath(existingSession.sandboxPath)}'`,
          60000,
          this.contextOf(existingSession)
        );
        return {
          success: true,
          sandboxPath: existingSession.sandboxPath,
          fileCount: existingSession.fileCount || 0,
          totalSize: existingSession.totalSize || 0,
        };
      } catch {
        log(`${this.logPrefix} Sandbox directory no longer exists, reinitializing...`);
        this.sessions.delete(sessionId);
      }
    }

    log(`${this.logPrefix} Initializing sync for session ${sessionId}`);
    log(`${this.logPrefix}   Host path: ${hostPath}`);

    // Use "cd ~ && pwd" because $HOME does not expand inside single quotes
    const homeResult = await this.execCommand('cd ~ && pwd', 60000, context);
    const homeDir = homeResult.stdout.trim() || this.fallbackHome;
    const sandboxPath = `${homeDir}/.claude/sandbox/${sessionId}`;
    log(`${this.logPrefix}   Sandbox path: ${sandboxPath}`);

    try {
      await this.execCommand(`mkdir -p '${shellEscapePath(sandboxPath)}'`, 60000, context);

      const rsyncCmd = buildRsyncCommand(this.toVmPath(hostPath), sandboxPath);
      log(`${this.logPrefix} Running: ${rsyncCmd}`);
      await this.execCommand(rsyncCmd, 300000, context); // 5 min timeout

      const countResult = await this.execCommand(
        `find '${shellEscapePath(sandboxPath)}' -type f | wc -l`,
        60000,
        context
      );
      const sizeResult = await this.execCommand(
        `du -sb '${shellEscapePath(sandboxPath)}' | cut -f1`,
        60000,
        context
      );

      const fileCount = parseInt(countResult.stdout.trim()) || 0;
      const totalSize = parseInt(sizeResult.stdout.trim()) || 0;

      this.sessions.set(
        sessionId,
        this.buildSession({ sessionId, hostPath, sandboxPath, context, fileCount, totalSize })
      );

      log(`${this.logPrefix} Sync complete: ${fileCount} files, ${this.formatSize(totalSize)}`);

      return { success: true, sandboxPath, fileCount, totalSize };
    } catch (error) {
      logError(`${this.logPrefix} Init sync failed:`, error);
      return {
        success: false,
        sandboxPath,
        fileCount: 0,
        totalSize: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Sync changes from the sandbox back to the host (without cleanup).
   * Called after each message to persist changes while keeping the sandbox alive.
   */
  protected static async syncToHost(sessionId: string): Promise<VmSyncResult> {
    validateSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      logError(`${this.logPrefix} Session not found: ${sessionId}`);
      return {
        success: false,
        sandboxPath: '',
        fileCount: 0,
        totalSize: 0,
        error: 'Session not found',
      };
    }

    log(`${this.logPrefix} Syncing to host for session ${sessionId}`);
    log(`${this.logPrefix}   Sandbox: ${session.sandboxPath}`);
    log(`${this.logPrefix}   Host: ${this.hostPathOf(session)}`);

    try {
      const vmDestPath = this.toVmPath(this.hostPathOf(session));
      const rsyncCmd = buildRsyncCommand(session.sandboxPath, vmDestPath);
      log(`${this.logPrefix} Running: ${rsyncCmd}`);

      await this.execCommand(rsyncCmd, 300000, this.contextOf(session)); // 5 min timeout

      session.lastSyncTime = Date.now();
      log(`${this.logPrefix} Sync to host complete for session ${sessionId}`);

      return {
        success: true,
        sandboxPath: session.sandboxPath,
        fileCount: session.fileCount || 0,
        totalSize: session.totalSize || 0,
      };
    } catch (error) {
      logError(`${this.logPrefix} Sync to host failed:`, error);
      return {
        success: false,
        sandboxPath: session.sandboxPath,
        fileCount: 0,
        totalSize: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Clean up the sandbox directory for a specific session.
   *
   * The resolved path is checked against the sandbox root before deletion so a
   * symlink inside the sandbox can never turn "rm -rf" into host-wide damage.
   */
  static async cleanup(sessionId: string): Promise<void> {
    validateSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      log(`${this.logPrefix} Session ${sessionId} not found, nothing to cleanup`);
      return;
    }

    log(`${this.logPrefix} Cleaning up session ${sessionId}`);

    try {
      if (this.cleanupSyncsFirst) {
        await this.syncToHost(sessionId);
      }

      const realPathResult = await this.execCommand(
        `realpath '${shellEscapePath(session.sandboxPath)}'`,
        60000,
        this.contextOf(session)
      );
      const realPath = realPathResult.stdout.trim();
      const sandboxRoot = sandboxRootOf(session.sandboxPath);
      if (!isRealPathWithinSandboxRoot(realPath, session.sandboxPath)) {
        logError(
          `${this.logPrefix} Refusing to delete: real path "${realPath}" is not within sandbox root "${sandboxRoot}"`
        );
        this.sessions.delete(sessionId);
        return;
      }

      await this.execCommand(
        `rm -rf '${shellEscapePath(session.sandboxPath)}'`,
        60000,
        this.contextOf(session)
      );
      this.sessions.delete(sessionId);
      log(`${this.logPrefix} Cleanup complete for session ${sessionId}`);
    } catch (error) {
      logError(`${this.logPrefix} Cleanup failed:`, error);
      if (this.dropsSessionOnCleanupError) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Copy a single file from the host into the sandbox.
   * Used for file attachments after the sandbox is already initialized.
   */
  static async syncFileToSandbox(
    sessionId: string,
    hostSourcePath: string,
    sandboxRelativePath: string
  ): Promise<VmSyncFileResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, sandboxPath: '', error: 'Session not found' };
    }

    const sandboxDestPath = `${session.sandboxPath}/${sandboxRelativePath}`;

    // Reject traversal before running anything: the destination must stay inside the root
    if (!isPathWithinRoot(sandboxDestPath, session.sandboxPath)) {
      return {
        success: false,
        sandboxPath: sandboxDestPath,
        error: `Path traversal detected: destination "${sandboxRelativePath}" resolves outside sandbox root`,
      };
    }

    log(`${this.logPrefix} Syncing file to sandbox: ${hostSourcePath} -> ${sandboxDestPath}`);

    try {
      const destDir = sandboxDestPath.substring(0, sandboxDestPath.lastIndexOf('/'));
      await this.execCommand(
        `mkdir -p '${shellEscapePath(destDir)}'`,
        60000,
        this.contextOf(session)
      );

      const cpCmd = buildCopyCommand(this.toVmPath(hostSourcePath), sandboxDestPath);
      log(`${this.logPrefix} Running: ${cpCmd}`);
      await this.execCommand(cpCmd, 60000, this.contextOf(session)); // 1 min timeout

      log(`${this.logPrefix} File synced to sandbox: ${sandboxDestPath}`);

      return { success: true, sandboxPath: sandboxDestPath };
    } catch (error) {
      logError(`${this.logPrefix} File sync failed:`, error);
      return {
        success: false,
        sandboxPath: sandboxDestPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Cleanup all active sandbox sessions (called on app shutdown). */
  static async cleanupAllSessions(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());

    if (sessionIds.length === 0) {
      log(`${this.logPrefix} No active sessions to cleanup`);
      return;
    }

    log(`${this.logPrefix} Cleaning up ${sessionIds.length} active session(s)...`);

    const syncFirst = this.syncsBeforeCleanup;
    const results = await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        if (syncFirst) {
          await this.syncToHost(sessionId);
        }
        await this.cleanup(sessionId);
        return { sessionId, success: true };
      })
    );

    const succeeded = results.filter((entry) => entry.status === 'fulfilled').length;
    const failed = results.length - succeeded;

    log(`${this.logPrefix} Cleanup complete: ${succeeded} succeeded, ${failed} failed`);
  }
}
