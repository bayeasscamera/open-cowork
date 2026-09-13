/**
 * @module main/agent/claude-bridge
 * Direct Native Bridge to Claude Code CLI (/Users/bayeasssene/.local/bin/claude)
 *
 * Allows Open Cowork to invoke Claude Code as a specialized Elite Coding Subagent
 * or delegate complex repository refactoring directly to the local CLI engine.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';

export interface ClaudeCodeExecutionOptions {
  prompt: string;
  cwd: string;
  dangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  onOutput?: (chunk: string) => void;
  onError?: (chunk: string) => void;
}

export class ClaudeCodeBridge {
  private static binaryPath = '/Users/bayeasssene/.local/bin/claude';

  public static isInstalled(): boolean {
    return fs.existsSync(this.binaryPath);
  }

  public static executePrompt(options: ClaudeCodeExecutionOptions): Promise<{ exitCode: number; fullOutput: string }> {
    return new Promise((resolve, reject) => {
      if (!this.isInstalled()) {
        return reject(new Error(`Binaire Claude Code introuvable à: ${this.binaryPath}`));
      }

      const args = ['-p', options.prompt];

      if (options.dangerouslySkipPermissions) {
        args.push('--allow-dangerously-skip-permissions');
      }

      if (options.allowedTools && options.allowedTools.length > 0) {
        args.push('--allowed-tools', options.allowedTools.join(','));
      }

      const child = spawn(this.binaryPath, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
        },
      });

      let fullOutput = '';

      child.stdout.on('data', (data) => {
        const text = data.toString();
        fullOutput += text;
        if (options.onOutput) options.onOutput(text);
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        fullOutput += text;
        if (options.onError) options.onError(text);
      });

      child.on('close', (code) => {
        resolve({
          exitCode: code ?? 0,
          fullOutput,
        });
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }
}
