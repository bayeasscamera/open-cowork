/**
 * @module main/tools/run-code-tool
 *
 * The `run_code` tool: the only way model-written code reaches execution.
 *
 * This is a thin adapter. It performs no evaluation, holds no authority and
 * makes no policy decision of its own — the child runs under an OS sandbox
 * (run-code-sandbox.ts), every `tools.*()` call it makes is re-gated through
 * invokeTool (run-code-host.ts), and approvals are the session's. Everything the
 * tool does is: validate the arguments, gather the dependencies, delegate.
 *
 * It is registered in the tool registry but is NOT in any preset's allow-list,
 * so the preset gate refuses it until a user turns code mode on. That is the
 * only thing standing between the registry and reachability, which is why adding
 * it to an allow-list is a separate, deliberate act.
 *
 * @module
 */

import { runCode, type RunCodeRequest } from '../agent/run-code-host';
import type { ToolDefinition, ToolRegistry } from './registry';
import type { ToolGateDeps } from './pipeline';
import type { PrunerSettings } from './invoke';
import { logWarn } from '../utils/logger';
// Single source of truth for the name: the presenter keys its "always direct"
// list on it, and two constants would drift.
import { RUN_CODE_TOOL_NAME } from '../presets/tool-presenter';

export { RUN_CODE_TOOL_NAME };

/** What the caller must supply for the host to enforce anything. */
export interface RunCodeToolDeps {
  registry: ToolRegistry;
  gate: ToolGateDeps;
  /** The session's own approval handler; approvals are never inherited. */
  requestPermission?: RunCodeRequest['requestPermission'];
  /** The app's userData directory, denied to the child: it holds API keys. */
  appDataPath?: string;
  /**
   * The active preset's allow-list. Passed in rather than read from a global:
   * this is the boundary the code path is confined to, so the caller that knows
   * which preset is active supplies it explicitly.
   */
  allowedTools: readonly string[];
  /** The active preset's trimmer, applied to output before it reaches the model. */
  pruner?: PrunerSettings;
}

/**
 * Build the `run_code` tool definition.
 *
 * `execute` resolves rather than throws for every expected refusal (no sandbox
 * on this platform, no child in this build, a compile error, a timeout). The
 * model needs a message it can act on, and a thrown error here would be
 * indistinguishable from a tool bug.
 */
export function buildRunCodeTool(deps: RunCodeToolDeps): ToolDefinition {
  return {
    name: RUN_CODE_TOOL_NAME,
    description:
      'Run TypeScript in an isolated child process. The script receives a `tools` object ' +
      'and may call the same tools you can; each call is permission-checked and confined ' +
      'to the workspace exactly as a direct call would be. Prefer this over several ' +
      'sequential tool calls when the work is procedural. The child has no network, ' +
      'cannot read credentials, and cannot write outside the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description:
            'TypeScript source. Must export a default async function taking `tools`, e.g. ' +
            '`export default async (tools) => await tools.read({ path: "README.md" })`.',
        },
      },
      required: ['source'],
    } as unknown as ToolDefinition['inputSchema'],
    risk: 'write',
    execute: async (args, ctx) => {
      const source = (args as { source?: unknown } | undefined)?.source;
      if (typeof source !== 'string' || source.trim() === '') {
        return {
          content: 'run_code needs a non-empty `source` string.',
          isError: true,
        };
      }

      try {
        const result = await runCode({
          source,
          sessionId: ctx.sessionId,
          cwd: ctx.cwd,
          registry: deps.registry,
          gate: deps.gate,
          appDataPath: deps.appDataPath,
          allowedTools: deps.allowedTools,
          ...(deps.pruner ? { pruner: deps.pruner } : {}),
          ...(deps.requestPermission ? { requestPermission: deps.requestPermission } : {}),
        });

        if (result.status === 'completed') {
          return { content: result.output || '(the script returned nothing)' };
        }
        // The reason is forwarded verbatim: it is written to be shown to the
        // model, and rewriting it here would lose the specifics that let the
        // script adapt.
        return {
          content: result.error ?? `run_code ended with status ${result.status}.`,
          isError: true,
        };
      } catch (error) {
        // The host resolves for expected failures, so reaching here is a real
        // bug. Report it rather than crashing the tool loop.
        const message = error instanceof Error ? error.message : String(error);
        logWarn(`[run_code] unexpected host failure: ${message}`);
        return { content: `run_code failed unexpectedly: ${message}`, isError: true };
      }
    },
  };
}

/** Re-exported so the pruner settings type stays in one place for callers. */
export type { PrunerSettings };
