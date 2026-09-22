/**
 * @module main/agent/agent-runner-sandbox-session
 *
 * Sandbox session bootstrap for a single agent run.
 *
 * Responsibility (extracted from CoworkAgentRunner.run()):
 * - decide whether an isolated sandbox (WSL on Windows, Lima on macOS) is active,
 * - sync the project working directory into the VM,
 * - copy the built-in and user skills into the VM so the model can read them,
 * - emit the sandbox.sync progress events the UI displays,
 * - return the VM workspace path so the rest of the run can hide it.
 *
 * The module never touches Electron or the config store: every platform side
 * effect (command execution, path translation, skills lookup, renderer
 * notification) is injected, so the whole bootstrap is unit-testable.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { log, logError } from '../utils/logger';
import { SandboxSync } from '../sandbox/sandbox-sync';
import type { SandboxSyncStatus } from '../../shared/types';
import type { VmSyncResult } from '../sandbox/sandbox-vm-sync';

/** Splits VM command output into non-empty lines (handles CRLF). */
const LINE_BREAK = /\r?\n/;

/** Which isolated backend this run has to bootstrap, if any. */
export type SandboxBackend = { kind: 'wsl'; distro: string } | { kind: 'lima' } | { kind: 'none' };

/** Platform facts the activation rule needs (read from the sandbox adapter). */
export interface SandboxActivationInput {
  isWsl: boolean;
  wslDistro?: string | null;
  isLima: boolean;
  limaInstanceRunning?: boolean;
  hasWorkingDir: boolean;
}

/**
 * Pure activation rule: a sandbox is bootstrapped only when its backend is ready
 * AND the session has a working directory to sync. WSL wins when both report
 * ready (the adapter mode is exclusive, so this is only a guard).
 */
export function resolveSandboxBackend(input: SandboxActivationInput): SandboxBackend {
  if (!input.hasWorkingDir) return { kind: 'none' };
  if (input.isWsl && input.wslDistro) return { kind: 'wsl', distro: input.wslDistro };
  if (input.isLima && input.limaInstanceRunning) return { kind: 'lima' };
  return { kind: 'none' };
}

/** Everything the bootstrap needs from its host, all injectable for tests. */
export interface SandboxSessionInitDeps {
  sessionId: string;
  /** Host directory to sync into the VM; missing means no sandbox work at all. */
  workingDir?: string;
  backend: SandboxBackend;
  /** Built-in skills shipped with the app (resolved lazily). */
  getBuiltinSkillsPath: () => string;
  /** Runtime skills directory user/global skills are materialised into (lazily). */
  getRuntimeSkillsDir: () => string;
  syncUserSkills: (runtimeSkillsDir: string) => void;
  syncConfiguredSkills: (runtimeSkillsDir: string) => void;
  /** Host path -> VM path, applied to rsync sources (WSL needs /mnt/..., Lima does not). */
  toVmPath: (hostPath: string) => string;
  notify: (status: SandboxSyncStatus) => void;
}

export interface SandboxSessionInitResult {
  sandboxPath: string | null;
  useSandboxIsolation: boolean;
}

/** Per-backend presentation text, session lookup and VM command execution. */
interface BackendIo {
  label: string;
  syncingFilesDetail: string;
  fallbackLog: string;
  hasSession: (sessionId: string) => boolean;
  initSync: (workingDir: string, sessionId: string) => Promise<VmSyncResult>;
  run: (command: string[], timeoutMs: number) => string;
  toVmPath: (hostPath: string) => string;
}

/** Builds a VM command runner from a launcher, e.g. ('wsl', ['-d', distro, '-e']). */
const commandRunner =
  (file: string, prefix: string[]) =>
  (command: string[], timeoutMs: number): string =>
    execFileSync(file, [...prefix, ...command], { encoding: 'utf-8', timeout: timeoutMs });

const resolveBackendIo = async (
  backend: SandboxBackend,
  deps: SandboxSessionInitDeps
): Promise<BackendIo | null> => {
  if (backend.kind === 'wsl') {
    return {
      label: 'WSL',
      syncingFilesDetail: 'Copying project files to isolated WSL environment',
      fallbackLog: '[CoworkAgentRunner] Falling back to /mnt/ access (less secure)',
      hasSession: (sessionId) => SandboxSync.hasSession(sessionId),
      initSync: (workingDir, sessionId) =>
        SandboxSync.initSync(workingDir, sessionId, backend.distro),
      run: commandRunner('wsl', ['-d', backend.distro, '-e']),
      toVmPath: deps.toVmPath,
    };
  }

  if (backend.kind === 'lima') {
    const { LimaSync } = await import('../sandbox/lima-sync');
    return {
      label: 'Lima',
      syncingFilesDetail: 'Copying project files to isolated Lima environment',
      fallbackLog: '[CoworkAgentRunner] Falling back to direct access (less secure)',
      hasSession: (sessionId) => LimaSync.hasSession(sessionId),
      initSync: (workingDir, sessionId) => LimaSync.initSync(workingDir, sessionId),
      run: commandRunner('limactl', ['shell', 'claude-sandbox', '--']),
      // Lima mounts /Users directly, so host paths are already VM paths.
      toVmPath: (hostPath) => hostPath,
    };
  }

  return null;
};

/**
 * Copies the built-in and user skills into the VM workspace.
 *
 * Failures are logged but never abort the run: the agent can still work, it just
 * will not see the skills. This mirrors the historical inline behaviour.
 */
const copySkillsIntoVm = (
  deps: SandboxSessionInitDeps,
  io: BackendIo,
  sandboxPath: string
): void => {
  const sandboxSkillsPath = `${sandboxPath}/.claude/skills`;

  try {
    io.run(['mkdir', '-p', sandboxSkillsPath], 10_000);

    const builtinSkillsPath = deps.getBuiltinSkillsPath();
    if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
      const source = io.toVmPath(builtinSkillsPath);
      log(`[CoworkAgentRunner] Copying skills with rsync: ${source}/ -> ${sandboxSkillsPath}/`);
      io.run(['rsync', '-av', `${source}/`, `${sandboxSkillsPath}/`], 120_000);
    }

    const appSkillsDir = deps.getRuntimeSkillsDir();
    if (!fs.existsSync(appSkillsDir)) {
      fs.mkdirSync(appSkillsDir, { recursive: true });
    }
    deps.syncUserSkills(appSkillsDir);
    deps.syncConfiguredSkills(appSkillsDir);

    if (fs.existsSync(appSkillsDir)) {
      const source = io.toVmPath(appSkillsDir);
      log(
        `[CoworkAgentRunner] Copying app skills with rsync: ${source}/ -> ${sandboxSkillsPath}/`
      );
      io.run(['rsync', '-avL', `${source}/`, `${sandboxSkillsPath}/`], 120_000);
    }

    const copiedSkills = io
      .run(['ls', sandboxSkillsPath], 10_000)
      .trim()
      .split(LINE_BREAK)
      .filter(Boolean);

    log(`[CoworkAgentRunner] Skills copied to sandbox: ${sandboxSkillsPath}`);
    log(`[CoworkAgentRunner]   Skills: ${copiedSkills.join(', ')}`);
  } catch (error) {
    logError('[CoworkAgentRunner] Failed to copy skills to sandbox:', error);
  }
};

/**
 * Syncs the session workspace and skills into the active VM sandbox.
 *
 * Returns the VM workspace path plus the isolation flag the run keeps for the
 * rest of its life. When no backend is active, the sync fails, or the session
 * has no working directory, isolation stays off and the caller falls back to
 * direct host access.
 */
export async function initSandboxSession(
  deps: SandboxSessionInitDeps
): Promise<SandboxSessionInitResult> {
  const off: SandboxSessionInitResult = { sandboxPath: null, useSandboxIsolation: false };

  if (!deps.workingDir) return off;

  const io = await resolveBackendIo(deps.backend, deps);
  if (!io) return off;

  log(`[CoworkAgentRunner] ${io.label} mode active, initializing sandbox sync...`);

  // The sync progress UI is only useful for the first message of a session.
  const isNewSession = !io.hasSession(deps.sessionId);

  if (isNewSession) {
    deps.notify({
      sessionId: deps.sessionId,
      phase: 'syncing_files',
      message: 'Syncing files to sandbox...',
      detail: io.syncingFilesDetail,
    });
  }

  const syncResult = await io.initSync(deps.workingDir, deps.sessionId);

  if (!syncResult.success) {
    logError('[CoworkAgentRunner] Sandbox sync failed:', syncResult.error);
    log(io.fallbackLog);

    if (isNewSession) {
      deps.notify({
        sessionId: deps.sessionId,
        phase: 'error',
        message: 'Sandbox file sync failed, falling back to direct access mode',
        detail: 'Falling back to direct access mode (less secure)',
      });
    }

    return off;
  }

  const { sandboxPath } = syncResult;
  log(`[CoworkAgentRunner] Sandbox initialized: ${sandboxPath}`);
  log(`[CoworkAgentRunner]   Files: ${syncResult.fileCount}, Size: ${syncResult.totalSize} bytes`);

  if (isNewSession) {
    deps.notify({
      sessionId: deps.sessionId,
      phase: 'syncing_skills',
      message: 'Configuring skills...',
      detail: 'Copying built-in skills to sandbox',
      fileCount: syncResult.fileCount,
      totalSize: syncResult.totalSize,
    });
  }

  copySkillsIntoVm(deps, io, sandboxPath);

  if (isNewSession) {
    deps.notify({
      sessionId: deps.sessionId,
      phase: 'ready',
      message: 'Sandbox ready',
      detail: `Synced ${syncResult.fileCount} files`,
      fileCount: syncResult.fileCount,
      totalSize: syncResult.totalSize,
    });
  }

  return { sandboxPath, useSandboxIsolation: true };
}

/** Everything the host back-sync needs; all effects are injected. */
export interface SandboxBackSyncDeps {
  sessionId: string;
  /** True only when this run actually synced into a VM. */
  useSandboxIsolation: boolean;
  sandboxPath: string | null;
  /** Resolved lazily, inside the guarded block, exactly like the inline code did. */
  getPlatform: () => { isWsl: boolean; isLima: boolean };
  /** Called with the user-facing failure sentence; the caller owns the wording around it. */
  onWarning: (text: string) => void;
}

/**
 * Copies VM changes back to the host when the run happened inside a sandbox.
 *
 * The sandbox is deliberately left alive (no cleanup): the next message of the
 * session reuses it. Any failure - including a broken adapter lookup - becomes a
 * user warning instead of failing the run.
 */
export async function syncSandboxChangesToHost(deps: SandboxBackSyncDeps): Promise<void> {
  if (!deps.useSandboxIsolation || !deps.sandboxPath) return;

  const { sessionId } = deps;

  try {
    const { isWsl, isLima } = deps.getPlatform();

    if (isWsl) {
      log('[CoworkAgentRunner] Syncing sandbox changes to Windows...');
      const syncResult = await SandboxSync.syncToWindows(sessionId);
      if (syncResult.success) {
        log('[CoworkAgentRunner] Sync completed successfully');
      } else {
        logError('[CoworkAgentRunner] Sync failed:', syncResult.error);
      }
      return;
    }

    if (isLima) {
      log('[CoworkAgentRunner] Syncing sandbox changes to macOS...');
      const { LimaSync } = await import('../sandbox/lima-sync');
      const syncResult = await LimaSync.syncToMac(sessionId);
      if (syncResult.success) {
        log('[CoworkAgentRunner] Sync completed successfully');
      } else {
        logError('[CoworkAgentRunner] Sync failed:', syncResult.error);
      }
    }
  } catch (syncErr) {
    logError('[CoworkAgentRunner] Sandbox sync error:', syncErr);
    deps.onWarning(
      `Sandbox sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`
    );
  }
}
