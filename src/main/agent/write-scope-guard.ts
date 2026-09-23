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

    if (shellTools.has(name) && !capabilities.includes('shell')) {
      return {
        block: true,
        reason: 'Task "' + task.id + '" does not hold the shell capability.',
      };
    }

    return undefined;
  };
}
