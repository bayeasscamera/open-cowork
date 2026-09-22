/**
 * Shared lifecycle + JSON-RPC executor surface for the in-VM sandbox bridges.
 *
 * The WSL (Windows) and Lima (macOS) bridges only differ in how the agent
 * process is spawned, which path converter applies, and which tooling gets
 * provisioned. Everything else - the request/response plumbing, the
 * file/directory surface, the startup handshake and shutdown - is identical,
 * so it lives here once. Platform bridges keep their status probes and
 * installers and supply the small hooks below.
 */
import { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { log, logError } from '../utils/logger';
import { VMJsonRpcTransport } from './vm-jsonrpc-transport';
import type {
  SandboxConfig,
  SandboxExecutor,
  ExecutionResult,
  DirectoryEntry,
  PathConverter,
} from './types';

/** Escape a path before interpolating it inside a double-quoted shell string. */
function escapeForDoubleQuotes(value: string): string {
  return value.replace(/[\\$`"!]/g, '\\$&');
}

export abstract class SandboxVmBridge extends VMJsonRpcTransport implements SandboxExecutor {
  protected config: SandboxConfig | null = null;
  protected isInitialized = false;
  protected initPromise: Promise<void> | null = null;

  /** Directories (packaged + dev) holding this platform's agent entry point. */
  protected abstract readonly agentPathDirectories: { packaged: string; dev: string };

  /** The child process hosting the agent, or null when stopped. */
  protected abstract getAgentProcess(): ChildProcess | null;

  protected abstract setAgentProcess(process: ChildProcess | null): void;

  /** Path converter applied to every path that crosses the VM boundary. */
  protected abstract getPathConverterInstance(): PathConverter;

  /** Spawn the agent for this platform; the command is fully built by the base. */
  protected abstract spawnAgentProcess(nodeCommand: string): ChildProcess;

  /** Platform bootstrap: status checks, provisioning, then `startAgent()`. */
  protected abstract _initialize(config: SandboxConfig): Promise<void>;

  protected getAgentStdin(): NodeJS.WritableStream | null {
    return this.getAgentProcess()?.stdin ?? null;
  }

  async initialize(config: SandboxConfig): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._initialize(config);
    return this.initPromise;
  }

  /**
   * Start the agent process, wire its stdio/exit handlers and wait until it
   * answers a ping.
   */
  protected async startAgent(): Promise<void> {
    const agentPath = this.getAgentScriptPath();
    const vmAgentPath = this.getPathConverterInstance().toWSL(agentPath);

    // Verify the path contains expected segments to prevent path injection
    const normalizedAgentPath = vmAgentPath.replace(/\\/g, '/');
    const hasExpectedSegment = [
      `/${this.agentPathDirectories.packaged}/`,
      `/${this.agentPathDirectories.dev}/`,
    ].some((segment) => normalizedAgentPath.includes(segment));
    if (!hasExpectedSegment) {
      throw new Error(`Agent path does not contain expected path segment: ${agentPath}`);
    }

    if (!fs.existsSync(agentPath)) {
      throw new Error(`${this.agentName()} agent script not found: ${agentPath}`);
    }

    log(`${this.logTag} Starting agent from:`, vmAgentPath);

    // Validate agentPath doesn't contain shell metacharacters
    if (/[;&|`$(){}]/.test(vmAgentPath)) {
      throw new Error(`Invalid agent path: ${vmAgentPath}`);
    }

    // Need to source nvm.sh first since node is installed via nvm
    const nodeCommand = `source ~/.nvm/nvm.sh 2>/dev/null; node "${escapeForDoubleQuotes(vmAgentPath)}"`;
    log(`${this.logTag} Agent command:`, nodeCommand);

    const child = this.spawnAgentProcess(nodeCommand);
    this.setAgentProcess(child);

    // Handle stdout (JSON-RPC responses)
    child.stdout?.on('data', (data: Buffer) => {
      try {
        this.ingestStdout(data, () => this.getAgentProcess()?.kill());
      } catch (error) {
        logError(`${this.logTag} Error processing stdout data:`, error);
      }
    });

    // Handle stderr (logging)
    child.stderr?.on('data', (data: Buffer) => {
      log(`${this.logTag} Agent`, data.toString().trim());
    });

    // Handle process exit
    child.on('exit', (code, signal) => {
      log(`${this.logTag} Agent process exited:`, { code, signal });
      this.setAgentProcess(null);
      this.isInitialized = false;
      this.failAllPendingRequests();
    });

    child.on('error', (error) => {
      logError(`${this.logTag} Agent process error:`, error);
    });

    await this.waitForAgentReady();
  }

  async executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>
  ): Promise<ExecutionResult> {
    this.assertInitialized();

    const vmCwd = cwd ? this.getPathConverterInstance().toWSL(cwd) : undefined;

    const result = await this.sendRequest<{
      code: number;
      stdout: string;
      stderr: string;
    }>('executeCommand', { command, cwd: vmCwd, env }, this.config?.timeout || 60000);

    return {
      success: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
    };
  }

  async readFile(filePath: string): Promise<string> {
    this.assertInitialized();
    const result = await this.sendRequest<{ content: string }>('readFile', {
      path: this.getPathConverterInstance().toWSL(filePath),
    });
    return result.content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.assertInitialized();
    await this.sendRequest('writeFile', {
      path: this.getPathConverterInstance().toWSL(filePath),
      content,
    });
  }

  async listDirectory(dirPath: string): Promise<DirectoryEntry[]> {
    this.assertInitialized();
    const result = await this.sendRequest<{ entries: DirectoryEntry[] }>('listDirectory', {
      path: this.getPathConverterInstance().toWSL(dirPath),
    });
    return result.entries;
  }

  async fileExists(filePath: string): Promise<boolean> {
    this.assertInitialized();
    const result = await this.sendRequest<{ exists: boolean }>('fileExists', {
      path: this.getPathConverterInstance().toWSL(filePath),
    });
    return result.exists;
  }

  async deleteFile(filePath: string): Promise<void> {
    this.assertInitialized();
    await this.sendRequest('deleteFile', {
      path: this.getPathConverterInstance().toWSL(filePath),
    });
  }

  async createDirectory(dirPath: string): Promise<void> {
    this.assertInitialized();
    await this.sendRequest('createDirectory', {
      path: this.getPathConverterInstance().toWSL(dirPath),
    });
  }

  async copyFile(src: string, dest: string): Promise<void> {
    this.assertInitialized();
    await this.sendRequest('copyFile', {
      src: this.getPathConverterInstance().toWSL(src),
      dest: this.getPathConverterInstance().toWSL(dest),
    });
  }

  async runClaudeCode(
    prompt: string,
    options: {
      cwd?: string;
      model?: string;
      maxTurns?: number;
      systemPrompt?: string;
      env?: Record<string, string>;
    } = {}
  ): Promise<AsyncIterable<unknown>> {
    this.assertInitialized();

    const vmCwd = options.cwd ? this.getPathConverterInstance().toWSL(options.cwd) : undefined;

    const result = await this.sendRequest<{ messages: unknown[] }>(
      'runClaudeCode',
      {
        prompt,
        cwd: vmCwd,
        model: options.model,
        maxTurns: options.maxTurns,
        systemPrompt: options.systemPrompt,
        env: options.env,
      },
      300000
    ); // 5 minute timeout for claude-code

    return (async function* () {
      for (const msg of result.messages) {
        yield msg;
      }
    })();
  }

  async shutdown(): Promise<void> {
    const child = this.getAgentProcess();
    if (child) {
      try {
        await this.sendRequest('shutdown', {});
      } catch {
        // Ignore errors during shutdown
      }

      child.kill();
      this.setAgentProcess(null);
    }

    this.isInitialized = false;
    this.failAllPendingRequests();
    log(`${this.logTag} Bridge shutdown complete`);
  }

  getPathConverter(): PathConverter {
    return this.getPathConverterInstance();
  }

  get initialized(): boolean {
    return this.isInitialized;
  }

  private assertInitialized(): void {
    if (!this.isInitialized) {
      throw new Error(`${this.agentName()} bridge not initialized`);
    }
  }

  private getAgentScriptPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath || '', this.agentPathDirectories.packaged, 'index.js');
    }
    return path.join(__dirname, '..', '..', this.agentPathDirectories.dev, 'index.js');
  }

  private async waitForAgentReady(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${this.agentName()} agent startup timeout`));
      }, 30000);

      const checkReady = async () => {
        try {
          await this.sendRequest('ping', {});
          clearTimeout(timeout);
          resolve();
        } catch {
          setTimeout(checkReady, 500);
        }
      };

      setTimeout(checkReady, 1000);
    });

    log(`${this.logTag} Agent is ready`);
  }
}
