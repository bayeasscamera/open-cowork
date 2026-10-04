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
import { log, logWarn } from '../utils/logger';
import {
  normalizeToolName,
  toolRegistry,
  ToolRegistry,
  type ToolDefinition as CoworkToolDefinition,
  type ToolRisk,
} from '../tools/registry';
import type { MCPManager } from '../mcp/mcp-manager';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import { presentToolsForPreset, presenterFor } from '../presets/tool-presenter';
import type { AgentPreset } from '../presets/preset-schema';
import type { PrunerSettings } from '../tools/invoke';
import type { ToolGateDeps } from '../tools/pipeline';
import { buildRunCodeTool } from '../tools/run-code-tool';

export interface BuildRunCodeExecutorDeps {
  registry: ToolRegistry;
  gate: ToolGateDeps;
  allowedTools: readonly string[];
  pruner?: PrunerSettings;
}

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
  /**
   * The active agent preset. It decides which tools are even offered, and how
   * they are presented (one-by-one, or as a generated SDK driven by run_code).
   * Omitted in tests that do not care about presets; defaults to direct.
   */
  preset?: AgentPreset;
  /**
   * The shared gate, used to give `run_code` its real executor.
   *
   * Supplied by the caller rather than constructed here so the code path runs the
   * SAME policy as every other tool call. Constructing a second, near-identical
   * gate is precisely how a code path ends up obeying different rules.
   */
  gateForCode?: ToolGateDeps;
  /**
   * Creator Mode: plugin runtime service for the `install_plugin` tool.
   * When omitted the tool reports gracefully that the feature is unavailable.
   */
  pluginRuntimeService?: { install(pluginName: string): Promise<unknown> };
  /**
   * Creator Mode: session manager used to invalidate the skills setup after
   * `create_task_skill` or `install_plugin` so the runner reloads on next turn.
   */
  sessionManagerForCreator?: { invalidateSkillsSetup(): void };
  /** Daily Companion: memory manager to persist notes remembered across sessions. */
  memoryManager?: { addNote(title: string, content: string, tags?: string[]): string };
}

export async function buildPiSessionTools(deps: BuildPiSessionToolsDeps) {
  const mcpCustomTools = deps.mcpManager ? buildMcpCustomTools(deps.mcpManager) : [];
  const extensionCustomTools = deps.extensionCustomTools;
  const metaTools = buildAgentMetaTools({
    sessionId: deps.sessionId,
    cwd: deps.cwd,
    pluginRuntimeService: deps.pluginRuntimeService,
    sessionManager: deps.sessionManagerForCreator,
    memoryManager: deps.memoryManager,
  });
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

  // Catalog every tool this session can reach, so the agent preset, the tool
  // presenter and the run_code bridge validate against the real tool set.
  // `run_code` is built here rather than coming from the SDK: it is the one tool
  // whose implementation lives in this process, and the SDK has no equivalent to
  // contribute. It has to be in the catalog BEFORE presentation, or the presenter
  // filters out a tool the preset allows and the model is never offered it.
  const runCodeDefinition = deps.gateForCode
    ? buildRunCodeTool({
        registry: toolRegistry,
        gate: deps.gateForCode,
        allowedTools: deps.preset?.tools.allow ?? [],
        ...(deps.preset ? { pruner: deps.preset.pruner } : {}),
      })
    : null;

  const catalog = [...codingTools, ...customTools, ...(runCodeDefinition ? [runCodeDefinition] : [])];
  syncToolRegistry(catalog);

  // Register the real executor as well as cataloguing it. The catalog stub
  // refuses on purpose, so without this the tool would be offered and then fail
  // every call.
  if (runCodeDefinition) {
    registerRunCodeExecutor({
      registry: toolRegistry,
      gate: deps.gateForCode as ToolGateDeps,
      allowedTools: deps.preset?.tools.allow ?? [],
      ...(deps.preset ? { pruner: deps.preset.pruner } : {}),
    });
  }


  // Presentation. This is where the preset stops being configuration and starts
  // changing behaviour: in `direct` mode the model sees each tool as a tool, and
  // in `code` mode it sees a generated SDK driven through run_code instead.
  //
  // The presenter filters by the preset allow-list as well as choosing a mode,
  // so a tool the preset forbids is not offered at all and the model cannot waste
  // a turn discovering it is refused. The gate still enforces the same list
  // independently - defence in depth, not the enforcement.
  //
  // SCOPE, and it is deliberate: presentation governs the tools the preset is
  // about - the SDK's coding tools plus run_code. MCP, meta, web and image tools
  // are passed through untouched, because they were never preset-governed and
  // filtering them here would silently remove capabilities nobody asked to
  // remove. They are still in `catalog`, so the registry and the gate see
  // everything regardless.
  // The WRAPPED tools, not the raw coding tools: the wrapper layers are what the
  // SDK receives, and matching on their names keeps the filter aligned with what
  // is actually handed over. run_code joins them because it is the one tool the
  // SDK cannot contribute, and in code mode every other tool is hidden behind it
  // - omitting it from the presentation input emptied the model's catalog.
  const presentable = [...wrappedTools, ...(runCodeDefinition ? [runCodeDefinition] : [])];
  const presentableTools = presentable.map(toRegistryToolDefinition);
  const presented = deps.preset
    ? presentToolsForPreset(presentableTools, deps.preset)
    : { direct: presentableTools, viaCode: [] as string[], sdkSource: '' };

  const sdkToolNames = new Set(wrappedTools.map((tool) => tool.name));
  const selected = new Set(presented.direct.map((tool) => tool.name));

  return {
    // The SDK's share of the presented catalog. run_code is presented too but is
    // not an SDK tool, so it travels as a custom tool rather than being dropped.
    customTools: [
      ...customTools,
      ...(presented.direct.filter((tool) => !sdkToolNames.has(tool.name)) as unknown as typeof customTools),
    ],
    wrappedTools: wrappedTools.filter((tool) => selected.has(tool.name)) as typeof wrappedTools,
    // The generated SDK, when code mode is active. Empty in direct mode.
    codeSdkSource: presented.sdkSource,
    promptSection: deps.preset ? presenterFor(deps.preset).promptSection(presentableTools) : '',
  };
}

/**
 * Adapt an SDK tool to the registry's ToolDefinition shape.
 *
 * The SDK's tools carry `parameters` and no risk metadata; the registry's
 * definition requires `inputSchema` and `risk`. The risk comes from
 * inferToolRisk so both paths classify a tool identically — the presenter and
 * the gate must not disagree about what a tool is.
 */
function toRegistryToolDefinition(tool: {
  name: string;
  description?: string;
  parameters?: unknown;
}): CoworkToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: (tool.parameters ?? {
      type: 'object',
      properties: {},
    }) as CoworkToolDefinition['inputSchema'],
    risk: inferToolRisk(tool.name),
  } as unknown as CoworkToolDefinition;
}

/**
 * Classify a tool for the registry from its name.
 *
 * The pi SDK's `ToolDefinition` carries no risk metadata, so the risk of a
 * tool is derived once here, from the single place every tool is assembled.
 * Anything not recognized defaults to 'write' — the conservative class, since
 * an unknown tool must never be treated as harmless.
 */
export function inferToolRisk(name: string): ToolRisk {
  const lowered = name.toLowerCase();
  if (/^(mcp__.*__(read|list|search|get|describe)|read|ls|glob|grep)/.test(lowered)) return 'read';
  if (/^(web_search|web_fetch|fetch|http|mcp__.*__(search|fetch))/i.test(name)) return 'network';
  if (/^(bash|shell|run|execute|terminal)/.test(lowered)) return 'exec';
  return 'write';
}

/**
 * Populate the process-wide tool registry from this session's assembled tool
 * set, so presets, the presenter and the run_code bridge all see exactly the
 * catalog this session can use — not a separately maintained list that can
 * drift from reality.
 *
 * Replaces the previous entry rather than appending: the registry is
 * per-session state (MCP servers come and go), and `registerOrReplace` keeps a
 * renamed tool from lingering.
 */
export function syncToolRegistry(tools: Array<{ name: string; description?: string; parameters?: unknown }>): void {
  const fresh = new ToolRegistry();
  for (const tool of tools) {
    const name = normalizeToolName(tool.name);
    if (!name) {
      logWarn('[pi-session-tools] Skipping tool with an unusable name:', tool.name);
      continue;
    }
    const original = tools.find((t) => t.name === tool.name);
    fresh.registerOrReplace({
      name,
      description: original?.description ?? '',
      inputSchema: (original?.parameters ?? {}) as CoworkToolDefinition['inputSchema'],
      risk: inferToolRisk(name),
      // The registry is a catalog, not a second execution path: execution goes
      // through the SDK for built-ins and through invokeTool() for the rest.
      // This stub exists so the shape is complete and never silently invoked.
      execute: async () => ({
        content: `Tool '${name}' is catalogued but not executable through the registry; use the session tool set.`,
        isError: true,
      }),
    });
  }
  toolRegistry.clear();
  for (const tool of fresh.list()) toolRegistry.registerOrReplace(tool);
}

/**
 * Register the real `run_code` executor into the catalog.
 *
 * The registry is a CATALOG and its stub executors refuse on purpose, so the code
 * path needs the one tool that actually runs in this process wired in. Without
 * it, code mode is a feature whose entire purpose - calling tools - cannot work,
 * which is worse than code mode being absent.
 */
export function registerRunCodeExecutor(deps: BuildRunCodeExecutorDeps): void {
  toolRegistry.registerOrReplace(buildRunCodeTool(deps));
}
