/**
 * @module main/agent/permission-policy
 *
 * Cowork 4.0 — Phase 5 (product security): capability-, command- and path-level
 * permission decisions. The policy is deliberately data-driven so the approval
 * UI can render exactly why a command is allowed, asked for, or refused, and so
 * the audit log can cite the rule that matched.
 */

import * as path from 'node:path';
import type { ApprovalDecision, Capability } from '../../shared/task-contract';
import type { PermissionEvaluation } from '../../shared/workflow-types';

export type { PermissionEvaluation };

export interface PermissionRequest {
  capability: Capability;
  /** Shell command, when the capability is 'shell'. */
  command?: string;
  /** Target path, when the capability is path-scoped. */
  path?: string;
  description?: string;
}

export interface PermissionRule {
  id: string;
  capability: Capability;
  decision: ApprovalDecision;
  /**
   * Patterns matched against the command or path. Supported forms:
   * exact ('npm test'), prefix ('git push*'), suffix ('*--force'),
   * substring ('*rm -rf*'), or '*' (always).
   */
  patterns?: string[];
  /** Restrict the rule to paths that resolve outside the workspace root. */
  outsideWorkspaceOnly?: boolean;
}

export interface PermissionPolicy {
  workspaceRoot?: string;
  defaultDecision: ApprovalDecision;
  rules: PermissionRule[];
}

/**
 * Minimal glob matcher. Intentionally dependency-free and predictable: it does
 * not support character classes or nested globs, only the '*' wildcard.
 */
export function matchGlob(pattern: string, value: string): boolean {
  const p = pattern.trim();
  if (p === '' || p === '*') return true;
  return globToRegExp(p).test(value);
}

/**
 * Translate a glob into an anchored regexp. '**' crosses path separators,
 * '*' stays within a segment, everything else is literal.
 */
function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if ('\\^$.|?*+()[]{}'.includes(ch)) {
      source += '\\' + ch;
    } else {
      source += ch;
    }
  }
  return new RegExp(source + '$');
}

/** Normalise a path to forward slashes and resolve it when a root is provided. */
export function normalizePath(target: string, root?: string): string {
  const absolute = root ? path.resolve(root, target) : path.resolve(target);
  return absolute.split(path.sep).join('/');
}

/** True when `target` resolves inside `root` (or equals it). */
export function isPathInsideWorkspace(target: string, root?: string): boolean {
  if (!root) {
    return true;
  }
  const resolvedRoot = normalizePath(root);
  const resolvedTarget = normalizePath(target, root);
  if (resolvedTarget === resolvedRoot) {
    return true;
  }
  return resolvedTarget.startsWith(resolvedRoot + '/');
}

/**
 * Baseline product policy: read-only diagnostics run unattended, mutations and
 * anything leaving the machine require confirmation, and destructive commands
 * are refused outright.
 */
export const DEFAULT_PERMISSION_RULES: readonly PermissionRule[] = Object.freeze([
  { id: 'read.always', capability: 'read', decision: 'auto' },
  {
    id: 'shell.safe-diagnostics',
    capability: 'shell',
    decision: 'auto',
    patterns: [
      'npm test',
      'npm run test',
      'npm run test*',
      'npm run typecheck',
      'npm run lint',
      'npx tsc*',
      'npx vitest*',
      'git status',
      'git status*',
      'git diff',
      'git diff*',
      'git log*',
      'git branch*',
      'ls',
      'ls *',
      'pwd',
      'cat *',
      'rg *',
      'grep *',
    ],
  },
  {
    id: 'shell.destructive-forbidden',
    capability: 'shell',
    decision: 'forbidden',
    patterns: ['rm -rf /*', 'rm -rf ~*', 'sudo rm -rf*', '*--force*', 'mkfs*', 'dd if=*'],
  },
  { id: 'shell.requires-confirmation', capability: 'shell', decision: 'confirm' },
  {
    id: 'git.read-only',
    capability: 'git',
    decision: 'auto',
    patterns: ['git status*', 'git diff*', 'git log*', 'git show*', 'git branch*'],
  },
  {
    id: 'git.push-requires-confirmation',
    capability: 'git',
    decision: 'confirm',
    patterns: ['git push*', 'git reset*', 'git rebase*', 'git checkout*', 'git merge*'],
  },
  { id: 'git.default', capability: 'git', decision: 'confirm' },
  { id: 'write.requires-confirmation', capability: 'write', decision: 'confirm' },
  { id: 'network.requires-confirmation', capability: 'network', decision: 'confirm' },
  { id: 'browser.requires-confirmation', capability: 'browser', decision: 'confirm' },
  { id: 'mcp.requires-confirmation', capability: 'mcp', decision: 'confirm' },
  { id: 'outside-workspace.forbidden', capability: 'outside-workspace', decision: 'forbidden' },
]);

export function createDefaultPermissionPolicy(workspaceRoot?: string): PermissionPolicy {
  return {
    workspaceRoot,
    defaultDecision: 'confirm',
    rules: DEFAULT_PERMISSION_RULES.map((rule) => ({ ...rule })),
  };
}

function subjectFor(request: PermissionRequest): string {
  return request.command ?? request.path ?? '';
}

function ruleMatches(
  rule: PermissionRule,
  request: PermissionRequest,
  policy: PermissionPolicy
): boolean {
  if (rule.outsideWorkspaceOnly) {
    if (!request.path || isPathInsideWorkspace(request.path, policy.workspaceRoot)) {
      return false;
    }
  }
  if (!rule.patterns || rule.patterns.length === 0) {
    return true;
  }
  const subject = subjectFor(request);
  return rule.patterns.some((pattern) => matchGlob(pattern, subject));
}

/**
 * Evaluate one permission request against the policy. First matching rule wins;
 * otherwise the policy default applies.
 */
export function evaluatePermission(
  policy: PermissionPolicy,
  request: PermissionRequest
): PermissionEvaluation {
  if (
    request.capability === 'outside-workspace' &&
    request.path &&
    isPathInsideWorkspace(request.path, policy.workspaceRoot)
  ) {
    return {
      capability: request.capability,
      decision: 'auto',
      matchedRuleId: null,
      reason: 'Path resolves inside the workspace; no elevated access needed.',
    };
  }

  for (const rule of policy.rules) {
    if (rule.capability !== request.capability) {
      continue;
    }
    if (!ruleMatches(rule, request, policy)) {
      continue;
    }
    return {
      capability: request.capability,
      decision: rule.decision,
      matchedRuleId: rule.id,
      reason: 'Matched rule "' + rule.id + '".',
    };
  }

  return {
    capability: request.capability,
    decision: policy.defaultDecision,
    matchedRuleId: null,
    reason: 'No rule matched; policy default applied.',
  };
}

/** Convenience wrapper for shell commands. */
export function evaluateCommand(policy: PermissionPolicy, command: string): PermissionEvaluation {
  return evaluatePermission(policy, { capability: 'shell', command });
}

export interface PermissionBatchResult {
  allowed: boolean;
  blocked: PermissionEvaluation[];
  confirmations: PermissionEvaluation[];
  evaluations: PermissionEvaluation[];
}

/** Evaluate a set of requests; the batch is blocked if any is forbidden. */
export function evaluateBatch(
  policy: PermissionPolicy,
  requests: PermissionRequest[]
): PermissionBatchResult {
  const evaluations = requests.map((request) => evaluatePermission(policy, request));
  const blocked = evaluations.filter((evaluation) => evaluation.decision === 'forbidden');
  const confirmations = evaluations.filter((evaluation) => evaluation.decision === 'confirm');
  return { allowed: blocked.length === 0, blocked, confirmations, evaluations };
}
