/**
 * @module main/workspace/terminal-manager
 *
 * Cowork 4.0 — Phase 6: the embedded terminal of the agent control center.
 *
 * It runs the user shell as a *piped* child process (stdin/stdout/stderr), not
 * through a pseudo-terminal: this keeps the app free of a native PTY dependency
 * and is enough to run commands, read their output and stop them. Programs that
 * require a real TTY (full-screen editors, pagers) are out of scope, and the UI
 * says so. Output is kept in a bounded, sequence-numbered buffer so the renderer
 * can poll incrementally instead of re-reading everything.
 */

import { spawn } from 'child_process';
import { statSync } from 'fs';
import type {
  TerminalChunk,
  TerminalSessionInfo,
  TerminalSnapshot,
} from '../../shared/control-center-types';

export const DEFAULT_MAX_TERMINALS = 4;
export const DEFAULT_MAX_CHUNKS = 500;
/** Longest single output chunk kept. */
export const MAX_CHUNK_CHARS = 4000;
/** Longest accepted stdin write. */
export const MAX_WRITE_CHARS = 8000;

/** Minimal child-process surface the manager needs (keeps it unit-testable). */
export interface TerminalChildProcess {
  pid?: number;
  stdin: { write(data: string): unknown } | null;
  stdout: { on(event: string, listener: (chunk: unknown) => void): unknown } | null;
  stderr: { on(event: string, listener: (chunk: unknown) => void): unknown } | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: string): boolean;
}

export type TerminalSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string }
) => TerminalChildProcess;

/** Default shell per platform, used when the caller does not name one. */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

/**
 * Characters that would let a shell string smuggle extra arguments into the
 * spawn call. Absolute paths and bare names only.
 */
const UNSAFE_SHELL_CHARS: readonly string[] = [
  ' ',
  '\t',
  ';',
  '&',
  '|',
  '$',
  '<',
  '>',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '"',
  "'",
  '\\',
  '\n',
  '\r',
  '`',
];

export function isAcceptableShell(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > 512) {
    return false;
  }
  for (const character of UNSAFE_SHELL_CHARS) {
    if (trimmed.includes(character)) {
      return false;
    }
  }
  return trimmed.startsWith('/') || /^[A-Za-z0-9._-]+$/.test(trimmed);
}

function defaultSpawn(command: string, args: readonly string[], options: { cwd: string }) {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  // One documented cast: node ChildProcess is structurally compatible with the
  // narrow surface above, but its overloaded `on` does not unify cleanly.
  return child as unknown as TerminalChildProcess;
}

export interface TerminalManagerOptions {
  now?: () => number;
  idFactory?: () => string;
  shell?: string;
  spawn?: TerminalSpawn;
  maxTerminals?: number;
  maxChunks?: number;
  /** Directory probe; injectable so tests do not touch the real filesystem. */
  isDirectory?: (candidate: string) => boolean;
}

export interface OpenTerminalInput {
  sessionId: string;
  /** Working directory, already resolved and contained by the caller. */
  cwd: string;
  shell?: string;
}

interface TerminalSession {
  info: TerminalSessionInfo;
  child: TerminalChildProcess;
  chunks: TerminalChunk[];
  nextSeq: number;
  droppedChunks: number;
}

function defaultId(): string {
  return 'term-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function toText(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString('utf8');
  }
  return '';
}

function isDirectoryOnDisk(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Owns every embedded terminal. Terminals are keyed by id and scoped to the
 * session that opened them, so one session can never read another one output.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly spawnProcess: TerminalSpawn;
  private readonly shell: string;
  private readonly maxTerminals: number;
  private readonly maxChunks: number;
  private readonly isDirectory: (candidate: string) => boolean;

  constructor(options: TerminalManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? defaultId;
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.shell = options.shell ?? defaultShell();
    this.maxTerminals = Math.max(1, options.maxTerminals ?? DEFAULT_MAX_TERMINALS);
    this.maxChunks = Math.max(1, options.maxChunks ?? DEFAULT_MAX_CHUNKS);
    this.isDirectory = options.isDirectory ?? isDirectoryOnDisk;
  }

  public open(input: OpenTerminalInput): TerminalSnapshot {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) {
      throw new Error('A session id is required.');
    }
    const cwd = input.cwd?.trim();
    if (!cwd) {
      throw new Error('A working directory is required.');
    }
    if (!this.isDirectory(cwd)) {
      throw new Error('Working directory does not exist: ' + cwd);
    }
    if (this.sessions.size >= this.maxTerminals) {
      throw new Error('Too many open terminals (max ' + this.maxTerminals + ').');
    }
    const shell = (input.shell?.trim() || this.shell).trim();
    if (!isAcceptableShell(shell)) {
      throw new Error('Unsupported shell: ' + shell);
    }

    const child = this.spawnProcess(shell, [], { cwd });
    const id = this.idFactory();
    const info: TerminalSessionInfo = {
      id,
      sessionId,
      cwd,
      shell,
      running: true,
      exitCode: null,
      startedAt: this.now(),
    };
    const session: TerminalSession = { info, child, chunks: [], nextSeq: 1, droppedChunks: 0 };
    this.sessions.set(id, session);

    const append = (stream: TerminalChunk['stream'], chunk: unknown): void => {
      const text = toText(chunk);
      if (text.length === 0) {
        return;
      }
      for (let offset = 0; offset < text.length; offset += MAX_CHUNK_CHARS) {
        session.chunks.push({
          seq: session.nextSeq,
          stream,
          text: text.slice(offset, offset + MAX_CHUNK_CHARS),
          at: this.now(),
        });
        session.nextSeq += 1;
      }
      this.trim(session);
    };

    child.stdout?.on('data', (chunk: unknown) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: unknown) => append('stderr', chunk));
    child.on('error', (error: unknown) => {
      append('stderr', error instanceof Error ? error.message : String(error));
      this.markExited(session, null);
    });
    child.on('exit', (code: unknown) => {
      this.markExited(session, typeof code === 'number' ? code : null);
    });

    return this.snapshot(sessionId, id);
  }

  /** Send one line to the shell. A missing newline is added. */
  public write(sessionId: string, terminalId: string, data: string): void {
    const session = this.require(sessionId, terminalId);
    if (typeof data !== 'string') {
      throw new Error('Terminal input must be a string.');
    }
    if (data.length > MAX_WRITE_CHARS) {
      throw new Error('Terminal input is too long (max ' + MAX_WRITE_CHARS + ' characters).');
    }
    if (!session.info.running || !session.child.stdin) {
      throw new Error('Terminal ' + terminalId + ' is not running.');
    }
    session.child.stdin.write(data.endsWith('\n') ? data : data + '\n');
  }

  /**
   * Output the renderer has not seen yet. Pass the highest seq already shown to
   * receive only newer chunks.
   */
  public snapshot(sessionId: string, terminalId: string, sinceSeq = 0): TerminalSnapshot {
    const session = this.require(sessionId, terminalId);
    const floor = Number.isFinite(sinceSeq) ? Math.max(0, Math.floor(sinceSeq)) : 0;
    return {
      session: { ...session.info },
      output: session.chunks.filter((chunk) => chunk.seq > floor).map((chunk) => ({ ...chunk })),
      truncated: session.droppedChunks > 0,
      droppedChunks: session.droppedChunks,
    };
  }

  public list(sessionId?: string): TerminalSessionInfo[] {
    const result: TerminalSessionInfo[] = [];
    for (const session of this.sessions.values()) {
      if (sessionId && session.info.sessionId !== sessionId) {
        continue;
      }
      result.push({ ...session.info });
    }
    return result.sort((a, b) => a.startedAt - b.startedAt);
  }

  public close(sessionId: string, terminalId: string): boolean {
    const session = this.require(sessionId, terminalId);
    this.sessions.delete(session.info.id);
    this.killChild(session);
    return true;
  }

  /** Drop the buffered output of a terminal, keeping the process alive. */
  public clear(sessionId: string, terminalId: string): number {
    const session = this.require(sessionId, terminalId);
    const cleared = session.chunks.length;
    session.chunks = [];
    session.droppedChunks = 0;
    return cleared;
  }

  /** Kill every terminal; used by the app shutdown path. */
  public closeAll(): number {
    const count = this.sessions.size;
    for (const session of this.sessions.values()) {
      this.killChild(session);
    }
    this.sessions.clear();
    return count;
  }

  public size(): number {
    return this.sessions.size;
  }

  private require(sessionId: string, terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session || session.info.sessionId !== sessionId) {
      throw new Error('Unknown terminal: ' + terminalId);
    }
    return session;
  }

  private markExited(session: TerminalSession, exitCode: number | null): void {
    if (!session.info.running) {
      return;
    }
    session.info = {
      ...session.info,
      running: false,
      exitCode,
      endedAt: this.now(),
    };
  }

  private killChild(session: TerminalSession): void {
    if (!session.info.running) {
      return;
    }
    session.info = { ...session.info, running: false, endedAt: this.now() };
    try {
      session.child.kill();
    } catch {
      // The process may already be gone; closing the terminal still succeeds.
    }
  }

  private trim(session: TerminalSession): void {
    while (session.chunks.length > this.maxChunks) {
      session.chunks.shift();
      session.droppedChunks += 1;
    }
  }
}
