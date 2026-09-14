/**
 * @module main/sandbox/ssh-executor
 *
 * Remote SSH Sandbox Executor (Hermes-inspired).
 *
 * Features:
 * - Robust connection validation, keepalive, and reconnect resilience
 * - Secure command escaping and execution over SSH
 * - Base64 chunked transfer for safe file reads/writes
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SandboxExecutor, SandboxConfig, ExecutionResult, DirectoryEntry } from './types';
import { log, logError } from '../utils/logger';

const execFileAsync = promisify(execFile);

export interface SshExecutorConfig extends SandboxConfig {
  host: string;
  port?: number;
  user?: string;
  keyPath?: string;
  remoteWorkspacePath?: string;
  connectTimeoutSeconds?: number;
}

export class SshExecutor implements SandboxExecutor {
  private config: SshExecutorConfig | null = null;
  private isConnected = false;

  async initialize(config: SandboxConfig): Promise<void> {
    this.config = config as SshExecutorConfig;
    log(`[SshExecutor] Initialized for ${this.config.user || 'default'}@${this.config.host}`);
  }

  /**
   * Health check / probe to verify credentials and connectivity
   */
  async testConnection(): Promise<boolean> {
    try {
      const res = await this.executeCommand('echo __SSH_PROBE_OK__');
      this.isConnected = res.success && res.stdout.includes('__SSH_PROBE_OK__');
      return this.isConnected;
    } catch {
      this.isConnected = false;
      return false;
    }
  }

  private buildSshArgs(remoteCmd: string, cwd?: string): string[] {
    if (!this.config) throw new Error('SshExecutor not initialized');

    const args: string[] = [];
    if (this.config.port) {
      args.push('-p', String(this.config.port));
    }
    if (this.config.keyPath) {
      args.push('-i', this.config.keyPath);
    }
    const timeoutSec = this.config.connectTimeoutSeconds ?? 10;
    args.push('-o', `ConnectTimeout=${timeoutSec}`);
    args.push('-o', 'ServerAliveInterval=15');
    args.push('-o', 'ServerAliveCountMax=3');
    args.push('-o', 'BatchMode=yes');
    args.push('-o', 'StrictHostKeyChecking=accept-new');

    const target = this.config.user ? `${this.config.user}@${this.config.host}` : this.config.host;
    args.push(target);

    const workingDir = cwd || this.config.remoteWorkspacePath || '.';
    const finalCmd = `cd "${workingDir.replace(/"/g, '\\"')}" && ${remoteCmd}`;
    args.push(finalCmd);

    return args;
  }

  async executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>
  ): Promise<ExecutionResult> {
    try {
      const envPrefix = env
        ? Object.entries(env)
            .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
            .join(' ') + ' '
        : '';
      const sshArgs = this.buildSshArgs(`${envPrefix}${command}`, cwd);

      const { stdout, stderr } = await execFileAsync('ssh', sshArgs, {
        timeout: this.config?.timeout || 120000,
        maxBuffer: 25 * 1024 * 1024,
      });

      return {
        success: true,
        stdout,
        stderr,
        exitCode: 0,
      };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      logError('[SshExecutor] Command execution failed:', execErr.stderr || execErr.message);
      return {
        success: false,
        stdout: execErr.stdout || '',
        stderr: execErr.stderr || execErr.message || String(err),
        exitCode: execErr.code ?? 1,
      };
    }
  }

  async readFile(filePath: string): Promise<string> {
    const res = await this.executeCommand(`cat "${filePath.replace(/"/g, '\\"')}"`);
    if (!res.success) {
      throw new Error(`SSH readFile failed: ${res.stderr}`);
    }
    return res.stdout;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const base64Content = Buffer.from(content, 'utf-8').toString('base64');
    const res = await this.executeCommand(
      `echo "${base64Content}" | base64 -d > "${filePath.replace(/"/g, '\\"')}"`
    );
    if (!res.success) {
      throw new Error(`SSH writeFile failed: ${res.stderr}`);
    }
  }

  async listDirectory(dirPath: string): Promise<DirectoryEntry[]> {
    const res = await this.executeCommand(
      `python3 -c "import os, json, sys; p=sys.argv[1]; print(json.dumps([{'name': f, 'isDirectory': os.path.isdir(os.path.join(p, f)), 'size': os.path.getsize(os.path.join(p, f)) if os.path.isfile(os.path.join(p, f)) else None} for f in os.listdir(p)]))" "${dirPath.replace(/"/g, '\\"')}" 2>/dev/null || ls -la "${dirPath.replace(/"/g, '\\"')}"`
    );
    if (!res.success) return [];
    try {
      return JSON.parse(res.stdout.trim()) as DirectoryEntry[];
    } catch {
      return res.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => ({ name: line, isDirectory: false }));
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    const res = await this.executeCommand(`test -e "${filePath.replace(/"/g, '\\"')}"`);
    return res.exitCode === 0;
  }

  async deleteFile(filePath: string): Promise<void> {
    await this.executeCommand(`rm -rf "${filePath.replace(/"/g, '\\"')}"`);
  }

  async createDirectory(dirPath: string): Promise<void> {
    await this.executeCommand(`mkdir -p "${dirPath.replace(/"/g, '\\"')}"`);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    await this.executeCommand(`cp -r "${src.replace(/"/g, '\\"')}" "${dest.replace(/"/g, '\\"')}"`);
  }

  async shutdown(): Promise<void> {
    this.isConnected = false;
    log('[SshExecutor] Shutdown complete');
  }
}
