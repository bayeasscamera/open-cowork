/**
 * @module main/sandbox/ssh-executor
 *
 * Remote SSH Sandbox Executor (Hermes-inspired).
 *
 * Executes commands and file operations over standard SSH / SFTP,
 * enabling Open Cowork to run safely on remote Linux VPS or GPU instances.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SandboxExecutor, SandboxConfig, ExecutionResult, DirectoryEntry } from './types';
import { log } from '../utils/logger';

const execFileAsync = promisify(execFile);

export interface SshExecutorConfig extends SandboxConfig {
  host: string;
  port?: number;
  user?: string;
  keyPath?: string;
  remoteWorkspacePath?: string;
}

export class SshExecutor implements SandboxExecutor {
  private config: SshExecutorConfig | null = null;

  async initialize(config: SandboxConfig): Promise<void> {
    this.config = config as SshExecutorConfig;
    log(`[SshExecutor] Initialized for host ${this.config.host || 'local-ssh'}`);
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
        maxBuffer: 20 * 1024 * 1024,
      });

      return {
        success: true,
        stdout,
        stderr,
        exitCode: 0,
      };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number; message?: string };
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
    if (!res.success) {
      return [];
    }
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
    log('[SshExecutor] Shutdown complete');
  }
}
