/**
 * @module main/agent/write-scope-guard
 *
 * Cowork 4.0 — Phase 3.2/5: least privilege for a sub-agent. Before a tool call
 * runs, the guard checks it against the atomic task's declared write scope and
 * capability set. A write outside the scope, or a shell call without the shell
 * capability, is blocked with an explicit reason.
 *
 * Pure and injectable so it can be unit-tested without an agent session.
 */

import * as path from 'node:path';
import type { AtomicTask, Capability } from '../../shared/task-contract';
import { matchGlob, normalizePath } from './permission-policy';

/** Tools that mutate the workspace. */
export const WRITE_TOOLS: readonly string[] = [
  'write',
  'edit',
  'create_file',
  'create',
  'apply_patch',
  'str_replace_editor',
  'multi_edit',
];

/** Tools that execute commands. */
export const SHELL_TOOLS: readonly string[] = ['bash', 'shell', 'run_command', 'execute_command'];

export interface ToolCallShape {
  toolName: string;
  args: unknown;
}

export interface ToolBlock {
  block: boolean;
  reason?: string;
}

/** Extract a file path from the many shapes tool arguments take. */
export function toolCallPath(args: unknown): string | null {
  if (!args || typeof args !== 'object') {
    return null;
  }
  const candidate = args as Record<string, unknown>;
  for (const key of ['file_path', 'filePath', 'path', 'target_file', 'filename']) {
    const value = candidate[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/** Extract a shell command from the many shapes shell tool arguments take. */
export function toolCallCommand(args: unknown): string | null {
  if (!args || typeof args !== 'object') {
    return null;
  }
  const candidate = args as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script']) {
    const value = candidate[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/** Express a tool path relative to the task working directory when possible. */
export function relativeToScope(target: string, cwd: string): string {
  const absoluteTarget = path.resolve(cwd, target);
  const absoluteCwd = path.resolve(cwd);
  const normalizedTarget = normalizePath(absoluteTarget);
  const normalizedCwd = normalizePath(absoluteCwd);
  if (normalizedTarget === normalizedCwd) {
    return '';
  }
  if (normalizedTarget.startsWith(normalizedCwd + '/')) {
    return normalizedTarget.slice(normalizedCwd.length + 1);
  }
  return normalizedTarget;
}

/** Split a command line on the operators that start a new command. */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      current += char + command[index + 1];
      index += 1;
      continue;
    }
    const double = (char === '&' || char === '|') && command[index + 1] === char;
    if (char === '\n' || char === ';' || char === '|' || double) {
      segments.push(current);
      current = '';
      if (double) {
        index += 1;
      }
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** Tokenise one shell segment, honouring quotes and backslash escapes. */
function shellTokens(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '\\' && index + 1 < segment.length) {
      current += segment[index + 1];
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

/** Drop leading env assignments and wrappers so the real command is first. */
function stripShellPrefixes(tokens: string[]): string[] {
  const wrappers = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'xargs', 'nice']);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || wrappers.has(token)) {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function positional(tokens: string[]): string[] {
  return tokens.filter((token) => token.length > 0 && !token.startsWith('-'));
}

/** Redirects and their target, e.g. `> out.log` or `2>> err.log`. */
const REDIRECT_TARGET = /(?:^|[\s;|&])(?:\d*>>?|&>)\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g;

/** Device and pseudo-file targets that are never workspace writes. */
const DEVICE_TARGETS = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/zero',
  'nul',
  'NUL',
]);

/** Commands whose final positional argument names the file they write. */
const LAST_ARG_WRITERS = new Set(['cp', 'mv', 'install', 'rsync', 'ln', 'truncate', 'sed']);

/** Commands whose positional arguments all name files they write. */
const ALL_ARG_WRITERS = new Set(['tee', 'rm', 'rmdir', 'touch', 'mkdir', 'unlink', 'mkfile']);

/** Commands whose first positional argument is a mode/owner, not a path. */
const MODE_FIRST_WRITERS = new Set(['chmod', 'chown', 'chgrp']);

/**
 * Best-effort list of files a shell command writes to. The shell is a real
 * bypass around the path-based guard, so redirections and the common
 * file-writing utilities are parsed; an obfuscated command can still hide a
 * write, which is why the shell capability itself stays a policy decision.
 */
export function shellWriteTargets(command: string): string[] {
  const targets = new Set<string>();

  for (const match of command.matchAll(REDIRECT_TARGET)) {
    const raw = match[1];
    if (!raw) {
      continue;
    }
    const cleaned = raw.replace(/^['"]|['"]$/g, '');
    if (cleaned.length > 0 && !DEVICE_TARGETS.has(cleaned)) {
      targets.add(cleaned);
    }
  }

  for (const segment of shellSegments(command)) {
    const tokens = stripShellPrefixes(shellTokens(segment));
    if (tokens.length === 0) {
      continue;
    }
    const name = tokens[0];
    const args = tokens.slice(1);

    if (name === 'dd') {
      for (const arg of args) {
        if (arg.startsWith('of=') && arg.length > 3) {
          targets.add(arg.slice(3));
        }
      }
      continue;
    }

    if (name === 'git') {
      // Only the git forms that name the files they overwrite are tracked;
      // a bare "git commit" touches the index, not a path the scope can judge.
      const subIndex = args.findIndex((arg) => !arg.startsWith('-'));
      const sub = subIndex >= 0 ? args[subIndex] : '';
      const rest = subIndex >= 0 ? args.slice(subIndex + 1) : [];
      if (sub === 'rm') {
        for (const target of positional(rest)) {
          targets.add(target);
        }
      } else if (sub === 'checkout' || sub === 'restore') {
        const separator = rest.indexOf('--');
        if (separator >= 0) {
          for (const target of rest.slice(separator + 1)) {
            targets.add(target);
          }
        }
      }
      continue;
    }

    if (name === 'sed') {
      const inPlace = args.some(
        (arg) => arg === '-i' || arg.startsWith('-i') || arg === '--in-place'
      );
      if (!inPlace) {
        continue;
      }
    } else if (!LAST_ARG_WRITERS.has(name) && !ALL_ARG_WRITERS.has(name) && !MODE_FIRST_WRITERS.has(name)) {
      continue;
    }

    const paths = positional(args);
    if (LAST_ARG_WRITERS.has(name)) {
      const last = paths[paths.length - 1];
      if (last) {
        targets.add(last);
      }
    } else if (MODE_FIRST_WRITERS.has(name)) {
      for (const target of paths.slice(1)) {
        targets.add(target);
      }
    } else {
      for (const target of paths) {
        targets.add(target);
      }
    }
  }

  return [...targets];
}

export interface WriteScopeGuardOptions {
  /** Capabilities the task holds; anything else is refused. */
  capabilities?: readonly Capability[];
  /** Extra tools to treat as writers. */
  writeTools?: readonly string[];
}

/**
 * Build the before-tool-call hook for one task. Returning undefined lets the
 * call through; returning a block stops it before any side effect happens.
 */
export function createWriteScopeGuard(
  task: Pick<AtomicTask, 'id' | 'writeScope' | 'requestedCapabilities'>,
  cwd: string,
  options: WriteScopeGuardOptions = {}
): (call: ToolCallShape) => ToolBlock | undefined {
  const writeTools = new Set(options.writeTools ?? WRITE_TOOLS);
  const shellTools = new Set(SHELL_TOOLS);
  const capabilities = options.capabilities ?? task.requestedCapabilities;
  const scope = task.writeScope;

  return (call) => {
    const name = (call.toolName ?? '').trim();

    if (writeTools.has(name)) {
      if (scope.length === 0) {
        return {
          block: true,
          reason: 'Task "' + task.id + '" is read-only and may not modify files.',
        };
      }
      const target = toolCallPath(call.args);
      if (!target) {
        return {
          block: true,
          reason: 'Write call without a resolvable path is refused by the write-scope guard.',
        };
      }
      const relative = relativeToScope(target, cwd);
      const allowed = scope.some((pattern) => matchGlob(pattern, relative));
      if (!allowed) {
        return {
          block: true,
          reason:
            'Path "' + relative + '" is outside the declared write scope of task "' + task.id + '".',
        };
      }
    }

    if (shellTools.has(name)) {
      if (!capabilities.includes('shell')) {
        return {
          block: true,
          reason: 'Task "' + task.id + '" does not hold the shell capability.',
        };
      }
      const command = toolCallCommand(call.args);
      if (command) {
        for (const target of shellWriteTargets(command)) {
          const relative = relativeToScope(target, cwd);
          if (scope.length === 0) {
            return {
              block: true,
              reason:
                'Task "' +
                task.id +
                '" is read-only and may not modify files (shell target "' +
                relative +
                '").',
            };
          }
          if (!scope.some((pattern) => matchGlob(pattern, relative))) {
            return {
              block: true,
              reason:
                'Shell write to "' +
                relative +
                '" is outside the declared write scope of task "' +
                task.id +
                '".',
            };
          }
        }
      }
    }

    return undefined;
  };
}
