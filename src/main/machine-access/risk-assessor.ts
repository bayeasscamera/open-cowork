/**
 * @module main/machine-access/risk-assessor
 *
 * Central guard: `assessRisk(action, context)` returns ordinaire, dangereux
 * or suspect with reasons. Conservative by design — doubt escalates, never
 * de-escalates. Nothing is ever forbidden: dangerous/suspicious actions
 * require reinforced user approval in EVERY autonomy level.
 */

import type { RiskAssessment, RiskLevel } from './types';
import { isSensitivePath } from './sensitive-zones';

export type MachineActionKind =
  | 'fs-read'
  | 'fs-write'
  | 'fs-delete'
  | 'fs-batch'
  | 'command'
  | 'gui'
  | 'network-send'
  | 'app-launch'
  | 'project-rename';

export interface MachineAction {
  kind: MachineActionKind;
  /** Canonical target paths (files, dirs, batch members). */
  paths?: string[];
  /** Exact shell command, when kind === 'command'. */
  command?: string;
  /** Members of a batch operation. */
  batchSize?: number;
  /** Whether deletion bypasses the system trash. */
  bypassesTrash?: boolean;
  /** Requests privilege elevation (sudo/runas/drivers/rights). */
  elevated?: boolean;
  /** Formats, partitions, shuts down or reboots the machine. */
  destructiveSystem?: boolean;
  /** Changes system config or disables security protections. */
  systemConfig?: boolean;
  /** Downloads then executes directly (curl|sh and equivalents). */
  downloadAndExec?: boolean;
  /** Installs software outside the project. */
  installsSoftware?: boolean;
  /** Reads secret material (.env, private keys, tokens). */
  readsSecrets?: boolean;
}

export interface RiskContext {
  /** Action triggered by untrusted content (file, web page, tool result). */
  fromUntrustedContent?: boolean;
  /** Untrusted source label for the reconfirmation card. */
  untrustedSource?: string;
  /** Action does not match the user's request. */
  offRequest?: boolean;
  /** Abnormal volume/frequency (deletion loop, write burst). */
  abnormalVolume?: boolean;
  /** Retry after a user refusal. */
  retryAfterRefusal?: boolean;
  /** Leaves the working folder without apparent reason. */
  leavesWorkdir?: boolean;
  /** Mass-operation threshold (tunable). */
  massThreshold?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** True when the approval card may be skipped for ordinary actions. */
  autonomyAllowsOrdinary?: boolean;
}

const OBFUSCATION_PATTERNS = [
  /base64\s+(-d|--decode)/i,
  /\$'\\x/i,
  /\beval\b/,
  /-enc(odedCommand)?\b/i,
  /FromBase64String/i,
];

const HIGH_RISK_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/i, reason: 'privilege elevation (sudo)' },
  { pattern: /\brunas\b/i, reason: 'privilege elevation (runas)' },
  { pattern: /Set-ExecutionPolicy/i, reason: 'execution policy change' },
  { pattern: /\bmkfs\b/i, reason: 'filesystem formatting' },
  { pattern: /\bdd\s+.*of=\/dev/i, reason: 'raw device write (dd)' },
  { pattern: /\bformat\s+[A-Za-z]:/i, reason: 'disk formatting' },
  { pattern: /shutdown|reboot|halt|poweroff/i, reason: 'shutdown or reboot' },
  { pattern: /reg\s+(add|delete)/i, reason: 'system registry change' },
  { pattern: /net\s+(user|localgroup)/i, reason: 'account or group change' },
  { pattern: /takown|icacls|chmod\s+777\s+\//i, reason: 'permission change on system scope' },
  { pattern: /:\(\)\s*\{.*\};\s*:/, reason: 'fork bomb' },
  { pattern: /\brm\s+.*-r.*-f/i, reason: 'recursive forced deletion' },
  { pattern: /del\s+\/[sfq]/i, reason: 'forced deletion (del)' },
  { pattern: /rmdir\s+\/[sq]/i, reason: 'forced directory removal' },
];

export function classifyCommand(command: string): { dangerous: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const { pattern, reason } of HIGH_RISK_COMMAND_PATTERNS) {
    if (pattern.test(command)) reasons.push(reason);
  }
  if (/(curl|wget).*\|\s*(sudo\s+)?(ba|z|da|fi)?sh/i.test(command)) {
    reasons.push('download-then-execute pipe (curl|sh)');
  }
  for (const pattern of OBFUSCATION_PATTERNS) {
    if (pattern.test(command)) {
      reasons.push('obfuscated command');
      break;
    }
  }
  return { dangerous: reasons.length > 0, reasons };
}

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  const rank: Record<RiskLevel, number> = { ordinaire: 0, suspect: 1, dangereux: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Assess one action. Dangerous and suspicious both require reinforced
 * approval; suspicious additionally names its trigger for reconfirmation.
 */
export function assessRisk(action: MachineAction, context: RiskContext = {}): RiskAssessment {
  let level: RiskLevel = 'ordinaire';
  const reasons: string[] = [];
  const platform = context.platform ?? process.platform;

  const escalate = (next: RiskLevel, reason: string): void => {
    level = maxLevel(level, next);
    reasons.push(reason);
  };

  // ---- Dangerous categories (spec 2.4) ----
  const massThreshold = context.massThreshold ?? 50;
  if (
    action.kind === 'fs-batch' &&
    (action.batchSize ?? 0) > massThreshold
  ) {
    escalate('dangereux', `mass operation: ${action.batchSize} items exceeds threshold ${massThreshold}`);
  }
  if (action.kind === 'fs-delete' && action.bypassesTrash) {
    escalate('dangereux', 'deletion outside the system trash');
  }
  for (const p of action.paths ?? []) {
    if (isSensitivePath(p, { platform, homeDir: context.homeDir })) {
      escalate('dangereux', `sensitive zone: ${p}`);
      break;
    }
  }
  if (action.elevated) escalate('dangereux', 'privilege elevation requested');
  if (action.destructiveSystem) escalate('dangereux', 'format/partition/shutdown/reboot');
  if (action.systemConfig) escalate('dangereux', 'system configuration or protection change');
  if (action.downloadAndExec) escalate('dangereux', 'download-then-execute');
  if (action.installsSoftware) escalate('dangereux', 'software installation outside the project');
  if (action.kind === 'network-send') escalate('dangereux', 'data sent off the machine');
  if (action.readsSecrets) escalate('dangereux', 'secret material read');
  if (action.kind === 'command' && action.command) {
    const { dangerous, reasons: cmdReasons } = classifyCommand(action.command);
    if (dangerous) {
      for (const r of cmdReasons) escalate('dangereux', r);
    }
  }

  // ---- Suspicious categories (spec 2.4) ----
  if (context.fromUntrustedContent) {
    const src = context.untrustedSource ? ` from ${context.untrustedSource}` : '';
    escalate('suspect', `triggered by untrusted content${src}`);
  }
  if (context.offRequest) escalate('suspect', 'does not match the user request');
  if (context.abnormalVolume) escalate('suspect', 'abnormal volume or frequency');
  if (context.retryAfterRefusal) escalate('suspect', 'retry after a user refusal');
  if (context.leavesWorkdir) escalate('suspect', 'leaves the working folder without reason');
  if (
    action.kind === 'command' &&
    action.command &&
    OBFUSCATION_PATTERNS.some((p) => p.test(action.command ?? ''))
  ) {
    escalate('suspect', 'obfuscated command');
  }

  return { level, reasons };
}

/** True when the action may proceed without a card under the given autonomy. */
export function requiresApproval(
  assessment: RiskAssessment,
  autonomy: string,
  isSensitive: boolean
): boolean {
  if (assessment.level !== 'ordinaire' || isSensitive) return true;
  if (autonomy === 'ask-always') return true;
  return false;
}
