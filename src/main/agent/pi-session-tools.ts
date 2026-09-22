/**
 * @module main/agent/pi-session-tools
 *
 * Assembles the tool set handed to `createAgentSession`: MCP tools bridged from
 * the manager, extension tools, agent meta-tools, web tools, image tools and
 * the pi coding tools (with the default bash timeout and sudo wrappers).
 *
 * Extracted from CoworkAgentRunner.run() so the wiring is unit-testable without
 * a runner instance. The two environment-bound pieces — PATH enrichment and the
 * sudo password prompt — are injected; the pure builders are imported directly.
 */
import {
  createCodingTools,
  type BashToolOptions,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { buildMcpCustomTools } from './agent-runner-mcp-tools';
import { buildAgentMetaTools } from '../tools/dynamic-tool-creator';
import { buildWebTools } from './web-tools';
import { buildImageTools } from './image-tools';
import { wrapBashToolForSudo, wrapBashToolWithDefaultTimeout } from './agent-runner-bash-tools';
import { createWindowsBashOperations } from './windows-bash-operations';
import { log } from '../utils/logger';
import type { MCPManager } from '../mcp/mcp-manager';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';

export interface BuildPiSessionToolsDeps {
  mcpManager?: MCPManager;
  sessionId: string;
  cwd: string;
  /** Tools contributed by runtime extensions for this turn. */
  extensionCustomTools: AgentRuntimeCustomTool[];
  tavilyApiKey: string;
  braveApiKey: string;
  requestSudoPassword?: (
    sessionId: string,
    toolUseId: string,
    command: string
  ) => Promise<string | null>;
  /** Electron-bound PATH enrichment (no-op once already done). */
  enrichProcessPath: () => Promise<void>;
}

export async function buildPiSessionTools(deps: BuildPiSessionToolsDeps) {
  const mcpCustomTools = deps.mcpManager ? buildMcpCustomTools(deps.mcpManager) : [];
  const extensionCustomTools = deps.extensionCustomTools;
  const metaTools = buildAgentMetaTools({ sessionId: deps.sessionId, cwd: deps.cwd });
  const webTools = buildWebTools({
    tavilyApiKey: deps.tavilyApiKey,
    braveApiKey: deps.braveApiKey,
  });
  // Native image read (vision) + generation, confined to the session
  // workspace. The returned images ride back through the SAME
  // openCoworkImages channel the screenshot MCP tools already use, so the
  // chat renders them inline with no new plumbing.
  const imageTools = buildImageTools({ sessionId: deps.sessionId, cwd: deps.cwd });
  const customTools = [
    ...mcpCustomTools,
    ...extensionCustomTools,
    ...metaTools,
    ...webTools,
    ...imageTools,
  ];
  if (mcpCustomTools.length > 0) {
    log(
      `[CoworkAgentRunner] Registered ${customTools.length} total customTools (MCP: ${mcpCustomTools.length}):`,
      customTools.map((t) => t.name).join(', ')
    );
  }
  if (extensionCustomTools.length > 0) {
    log(
      `[CoworkAgentRunner] Registered ${extensionCustomTools.length} extension tools as customTools:`,
      extensionCustomTools.map((t) => t.name).join(', ')
    );
  }

  // Enrich process.env.PATH for build mode — ensures Skill commands (python3, node)
  // executed via Pi SDK's Bash tool can find bundled and user-installed executables.
  await deps.enrichProcessPath();

  const bashOptions: BashToolOptions | undefined =
    process.platform === 'win32' ? { operations: createWindowsBashOperations() } : undefined;
  const codingTools = createCodingTools(deps.cwd, bashOptions ? { bash: bashOptions } : undefined);

  // Inject a default 120s timeout for bash commands when the model omits one
  const withTimeout = wrapBashToolWithDefaultTimeout(codingTools as ToolDefinition[]);

  // Wrap the bash tool to intercept sudo commands and request passwords
  // Note: wrapBashToolForSudo returns ToolDefinition[] (5-param execute) but
  // createAgentSession.tools expects Tool[] (4-param execute). The extra ctx
  // parameter is simply not passed by the session runner — safe to cast.
  const wrappedTools = wrapBashToolForSudo(withTimeout, {
    requestSudoPassword: deps.requestSudoPassword,
    sessionId: deps.sessionId,
    effectiveCwd: deps.cwd,
  });

  return { customTools, wrappedTools };
}
