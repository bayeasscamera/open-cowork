/**
 * @module main/agent/machine-access-gate
 *
 * Machine access as a gate stage: classify the call with `assessRisk`, and
 * demand user approval for anything dangerous, suspicious, or touching a
 * sensitive zone — at EVERY autonomy level, including "allow-all".
 *
 * The user prompt is the session's EXISTING `requestPermission` round-trip, not
 * a new channel, which is what keeps one security property intact: the agent
 * has no way to answer it. Two further rules are enforced here:
 *
 * - `allow_always` is NOT honoured for a dangerous or suspicious action. The
 *   permission dialog offers that option for ordinary tools; this stage treats
 *   it as "ask again", because a standing approval must never cover an action
 *   the user has not seen.
 * - the approval binds to the exact action, and the action is re-assessed from
 *   the arguments the tool will actually run with.
 */

import { assessRisk, requiresApproval, type MachineAction } from '../machine-access/risk-assessor';
import { isSensitivePath } from '../machine-access/sensitive-zones';
import { peekMachineAccessService } from '../machine-access/runtime';
import { sanitizeToolResult } from '../machine-access/injection-guard';
import { log } from '../utils/logger';
import type { RequestPermission } from './agent-hooks';

/** Tools that can act on the machine, and how their arguments map to an action. */
interface ActionShape {
  kind: MachineAction['kind'];
  pathArgs: string[];
  readSecret?: boolean;
}

const MACHINE_TOOLS: Record<string, ActionShape> = {
  fs_read: { kind: 'fs-read', pathArgs: ['path'] },
  fs_list: { kind: 'fs-read', pathArgs: ['path'] },
  fs_search: { kind: 'fs-read', pathArgs: ['dir'] },
  fs_write: { kind: 'fs-write', pathArgs: ['path'] },
  fs_create: { kind: 'fs-write', pathArgs: ['path'] },
  fs_move: { kind: 'fs-write', pathArgs: ['src', 'dest'] },
  fs_rename: { kind: 'fs-write', pathArgs: ['src', 'dest'] },
  fs_copy: { kind: 'fs-write', pathArgs: ['src', 'dest'] },
  fs_trash: { kind: 'fs-delete', pathArgs: ['path'] },
  project_rename: { kind: 'project-rename', pathArgs: ['workdir'] },
  machine_run_command: { kind: 'command', pathArgs: [] },
};

function collectStrings(args: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) out.push(value);
  }
  return out;
}

export interface MachineAccessGateDeps {
  requestPermission?: RequestPermission;
  /** Session id, used to label the prompt. */
  sessionId: string;
  /** Where the request came from, when known (untrusted content). */
  origin?: { kind: 'user-message' | 'file-content' | 'web-content' | 'tool-result'; label?: string };
}

/**
 * Returns `blocked: true` only when the user REFUSED, or when the action needs
 * approval and no prompt could be shown. Never returns blocked for an ordinary
 * action under a permissive autonomy level.
 */
export async function assessMachineAccessCall(
  input: {
    toolName: string;
    args: Record<string, unknown>;
    cwd: string;
  },
  deps: MachineAccessGateDeps
): Promise<{ blocked: boolean; reason?: string }> {
  const shape = MACHINE_TOOLS[input.toolName];
  if (!shape) return { blocked: false };

  const service = peekMachineAccessService();
  // No service wired (isolated execution mode): machine access is not
  // available, and the tool itself refuses. Nothing to ask here.
  if (!service) return { blocked: false };

  const command = typeof input.args['command'] === 'string' ? (input.args['command'] as string) : undefined;
  const action: MachineAction = {
    kind: shape.kind,
    ...(command ? { command } : {}),
    ...(collectStrings(input.args, shape.pathArgs).length > 0
      ? { paths: collectStrings(input.args, shape.pathArgs) }
      : {}),
    ...(typeof input.args['batchSize'] === 'number'
      ? { batchSize: input.args['batchSize'] as number }
      : {}),
  };

  // A path that lands in a sensitive zone is flagged even when the risk rules
  // say the action itself is ordinary.
  const sensitive = action.paths?.some((p) =>
    isSensitivePath(p, { platform: process.platform })
  ) === true;

  const assessment = assessRisk(action, {
    fromUntrustedContent: deps.origin ? deps.origin.kind !== 'user-message' : false,
    ...(deps.origin?.label ? { untrustedSource: deps.origin.label } : {}),
  });

  const autonomy = service.autonomy;
  if (!requiresApproval(assessment, autonomy, sensitive)) {
    return { blocked: false };
  }

  const why = assessment.reasons.length > 0 ? assessment.reasons.join('; ') : 'machine-access policy';
  const origin = deps.origin
    ? `${deps.origin.kind}${deps.origin.label ? `: ${deps.origin.label}` : ''}`
    : 'user-message';

  // Ordinary action under a permissive level that still needs asking: nothing
  // to explain beyond the request itself.
  const elevated = assessment.level !== 'ordinaire' || sensitive;
  const reason = elevated
    ? `This action was judged ${assessment.level}: ${why}. Origin: ${origin}. ` +
      `Approve once, or refuse. There is no "always approve" for an action like this.`
    : `Autonomy level '${autonomy}' asks for confirmation. Origin: ${origin}.`;

  if (!deps.requestPermission) {
    // Fail CLOSED: with no way to ask, a dangerous action must not run.
    if (elevated) {
      return { blocked: true, reason: `${reason} (no user prompt available — refused rather than run unapproved)` };
    }
    return { blocked: false };
  }

  const describeAction = () =>
    sanitizeToolResult(
      `${command ?? `${shape.kind} ${action.paths?.join(' ') ?? ''}`} (${why})`,
      2000
    ).text;

  const decision = await deps.requestPermission(
    deps.sessionId,
    `machine-access-${input.toolName}`,
    input.toolName,
    {
      description: describeAction(),
      machineAccess: {
        level: assessment.level,
        reasons: assessment.reasons,
        sensitive,
        autonomy,
        origin,
      },
    }
  );

  if (decision === 'deny') {
    return { blocked: true, reason: `${reason} The user refused.` };
  }
  if (decision === 'allow_always' && elevated) {
    // A standing approval cannot cover an unseen dangerous action.
    log(
      `[MachineAccessGate] 'always allow' ignored for a ${assessment.level} action (${input.toolName}); asking each time.`
    );
    const second = await deps.requestPermission(
      deps.sessionId,
      `machine-access-once-${input.toolName}`,
      input.toolName,
      {
        description: describeAction(),
        machineAccess: {
          level: assessment.level,
          reasons: assessment.reasons,
          sensitive,
          autonomy,
          origin,
          oneShotOnly: true,
        },
      }
    );
    if (second === 'deny') {
      return { blocked: true, reason: `${reason} The user refused.` };
    }
  }

  return { blocked: false };
}