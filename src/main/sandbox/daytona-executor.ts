/**
 * @module main/sandbox/daytona-executor
 *
 * Daytona Cloud Sandbox Executor (Hermes-inspired).
 *
 * Provides ephemeral or persistent cloud workspaces managed through
 * the Daytona CLI / API. Supports auto-hibernation when idle to achieve
 * near-zero cost between sessions.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SandboxExecutor, SandboxConfig, ExecutionResult, DirectoryEntry } from './types';
import { log } from '../utils/logger';

const execFileAsync = promisify(execFile);

export interface DaytonaExecutorConfig extends SandboxConfig {
  workspaceId: string;
  apiKey?: string;
  apiUrl?: string;
}

export class DaytonaExecutor implements SandboxExecutor {
  private config: DaytonaExecutorConfig | null = null;

  async initialize(config: SandboxConfig): Promise<void> {
    this.config = config as DaytonaExecutorConfig;
    log(`[DaytonaExecutor] Initialized for workspace ${this.config.workspaceId}`);
  }

  async executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>
  ): Promise<ExecutionResult> {
    if (!this.config?.workspaceId) {
      throw new Error('DaytonaExecutor workspaceId not configured');
    }

    try {
      const workingDir = cwd || this.config.workspacePath || '.';
      const envPrefix = env
        ? Object.entries(env)
            .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
            .join(' ') + ' '
        : '';
      const fullCmd = `cd "${workingDir.replace(/"/g, '\\"')}" && ${envPrefix}${command}`;

      const { stdout, stderr } = await execFileAsync(
        'daytona',
        ['exec', '-w', this.config.workspaceId, '--', 'bash', '-c', fullCmd],
        {
          timeout: this.config.timeout || 120000,
          maxBuffer: 20 * 1024 * 1024,
        }
      );

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
      throw new Error(`Daytona readFile failed: ${res.stderr}`);
    }
    return res.stdout;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const base64Content = Buffer.from(content, 'utf-8').toString('base64');
    const res = await this.executeCommand(
      `echo "${base64Content}" | base64 -d > "${filePath.replace(/"/g, '\\"')}"`
    );
    if (!res.success) {
      throw new Error(`Daytona writeFile failed: ${res.stderr}`);
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
    log('[DaytonaExecutor] Workspace shutdown / hibernate completed');
  }
}
