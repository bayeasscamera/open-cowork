/**
 * LimaSync - Manages file synchronization between macOS and Lima sandbox
 *
 * This module provides complete isolation by:
 * 1. Copying files from macOS to an isolated Lima directory (~/.claude/sandbox/{sessionId})
 * 2. Running all operations within the isolated directory
 * 3. Syncing changes back to macOS when requested
 *
 * Lifecycle:
 * - Sandbox is created when a conversation starts (first message)
 * - Sandbox persists across multiple messages in the same conversation
 * - Sandbox is deleted when:
 *   - User deletes the conversation
 *   - App is closed/shutdown
 *
 * The registry and the sync/cleanup sequence live in SandboxVmSync; this file
 * only supplies the Lima transport, the macOS path mapping and the log prefix.
 */

import { isPathWithinRoot } from '../tools/path-containment';
import {
  SandboxVmSync,
  type VmSyncResult,
  type VmSyncSession,
  type VmSyncSessionInit,
} from './sandbox-vm-sync';

const LIMA_INSTANCE_NAME = 'claude-sandbox';

interface LimaSyncSession extends VmSyncSession {
  macPath: string; // Original macOS path (e.g. /Users/username/project)
}

type LimaSyncResult = VmSyncResult;

export class LimaSync extends SandboxVmSync {
  /** Lima sessions live in their own registry, shadowing the base declaration. */
  protected static override sessions: Map<string, VmSyncSession> = new Map();

  protected static override get logPrefix(): string {
    return '[LimaSync]';
  }

  protected static override get fallbackHome(): string {
    return '/home/user';
  }

  /** cleanup() syncs the sandbox back to macOS before deleting it. */
  protected static override get cleanupSyncsFirst(): boolean {
    return true;
  }

  /** Lima forgets a session once cleanup has run, whether it succeeded or not. */
  protected static override get dropsSessionOnCleanupError(): boolean {
    return true;
  }

  protected static override execCommand(
    command: string,
    timeout: number
  ): Promise<{ stdout: string; stderr: string }> {
    return this.limaExec(command, timeout);
  }

  protected static override hostPathOf(session: VmSyncSession): string {
    return (session as LimaSyncSession).macPath;
  }

  protected static override buildSession(init: VmSyncSessionInit): LimaSyncSession {
    return {
      sessionId: init.sessionId,
      macPath: init.hostPath,
      sandboxPath: init.sandboxPath,
      initialized: true,
      fileCount: init.fileCount,
      totalSize: init.totalSize,
      lastSyncTime: Date.now(),
    };
  }

  /**
   * Initialize sync session - copy files from macOS to Lima sandbox
   */
  static initSync(macPath: string, sessionId: string): Promise<LimaSyncResult> {
    return this.initSyncCore(macPath, sessionId);
  }

  /**
   * Sync changes from sandbox back to macOS (without cleanup)
   * Called after each message to persist changes while keeping sandbox alive
   */
  static async syncToMac(sessionId: string): Promise<LimaSyncResult> {
    return this.syncToHost(sessionId);
  }

  /**
   * Copy a single file to sandbox (deprecated - use syncFileToSandbox instead)
   */
  static async copyFileToSandbox(
    sessionId: string,
    macPath: string,
    relativePath: string
  ): Promise<boolean> {
    const result = await this.syncFileToSandbox(sessionId, macPath, relativePath);
    return result.success;
  }

  /** Get session info (narrowed to the Lima session shape) */
  static override getSession(sessionId: string): LimaSyncSession | undefined {
    return this.sessions.get(sessionId) as LimaSyncSession | undefined;
  }

  /**
   * Convert a macOS path to its sandbox equivalent
   */
  static macToSandboxPath(macPath: string, sessionId: string): string | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    if (isPathWithinRoot(macPath, session.macPath)) {
      const relativePath = macPath.substring(session.macPath.length);
      return session.sandboxPath + relativePath;
    }

    return null;
  }

  /**
   * Convert a sandbox path to its macOS equivalent
   */
  static sandboxToMacPath(sandboxPath: string, sessionId: string): string | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    if (isPathWithinRoot(sandboxPath, session.sandboxPath)) {
      const relativePath = sandboxPath.substring(session.sandboxPath.length);
      return session.macPath + relativePath;
    }

    return null;
  }

  /**
   * Execute command in Lima VM
   */
  private static async limaExec(
    command: string,
    timeout: number = 60000
  ): Promise<{ stdout: string; stderr: string }> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      const result = await execFileAsync(
        'limactl',
        ['shell', LIMA_INSTANCE_NAME, '--', 'bash', '-c', command],
        {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 50 * 1024 * 1024,
        }
      );

      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
      };
    } catch (error: unknown) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Format bytes to human-readable size
   */
  protected static override formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
  }
}
