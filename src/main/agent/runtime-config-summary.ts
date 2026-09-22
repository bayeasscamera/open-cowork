/**
 * @module main/agent/runtime-config-summary
 *
 * Builds the runtime-derived system-prompt sections appended to every agent
 * query: a self-description of the active configuration (`<your_configuration>`),
 * the workspace location (`<workspace_info>`) and the user's personal
 * instructions (`<user_instructions>`), then assembles the full append block
 * handed to the SDK session.
 *
 * Extracted from CoworkAgentRunner.run(). No Electron and no singleton state:
 * the runner computes the heavyweight sections (elite prompt, strategic prompt,
 * memory context) and passes them in as plain strings; this module owns only the
 * templates, the ordering and the blank-section filtering.
 *
 * SECURITY: the configuration summary intentionally excludes API keys, base
 * URLs and any other sensitive data — never add those fields here.
 */

export interface RuntimeConfigSummaryInput {
  modelId: string;
  provider: string;
  contextWindow?: number | string | null;
  maxTokens?: number | string | null;
  thinkingEnabled: boolean;
  sandboxEnabled: boolean;
  memoryEnabled: boolean;
}

export interface WorkspaceInfoInput {
  sandboxIsolated: boolean;
  sandboxPath?: string | null;
  workingDir?: string | null;
  /** Virtual root exposed inside the isolated sandbox (e.g. `/workspace`). */
  virtualWorkspacePath: string;
}

export interface CoworkAppendPromptInput {
  config: RuntimeConfigSummaryInput;
  workspace: WorkspaceInfoInput;
  coworkInstructions?: string | null;
  elitePrompt?: string | null;
  strategicPrompt?: string | null;
  bundledPathHints?: string | null;
  extensionSystemContext?: string | null;
  projectSystemPromptBlock?: string | null;
  userPreferences?: string | null;
  errorPatterns?: string | null;
  projectResumption?: string | null;
}

const COWORK_INTRODUCTION =
  'You are an Open Cowork assistant. Be concise, accurate, and tool-capable.';

const COWORK_BEHAVIORAL_RULES = `CRITICAL BEHAVIORAL RULES:
1. CHAT FIRST: By default, respond to the user in plain text within the conversation. Do NOT create, write, or edit files unless the user explicitly asks you to (e.g., "create a file", "write this to...", "edit the code", "save as...", mentions a specific file path, or describes code changes they want applied). For questions, summaries, explanations, analysis, and general conversation — always reply directly in chat text.
2. When a request is actionable, proceed immediately with reasonable assumptions. If you need clarification, ask briefly in plain text.
3. For relative time windows like "within two days" in browsing or research tasks, assume the most recent two relevant publication days unless the user explicitly defines another date range.
4. For bracketed placeholders like [Agent], [Topic], etc., treat the word inside brackets as the literal search keyword unless the user says otherwise.
5. When given a task, START DOING IT. Do not restate the task, do not list what you will do, do not ask for confirmation. Just execute.`;

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Build a concise summary of the agent's own runtime configuration. */
export function buildRuntimeConfigSummaryPrompt(input: RuntimeConfigSummaryInput): string {
  return `<your_configuration>
- Model: ${input.modelId}
- Provider: ${input.provider}
- Context Window: ${input.contextWindow || 'unknown'} tokens
- Max Output Tokens: ${input.maxTokens || 'default'}
- Thinking: ${input.thinkingEnabled ? 'enabled' : 'disabled'}
- Sandbox: ${input.sandboxEnabled ? 'enabled' : 'disabled'}
- Memory: ${input.memoryEnabled ? 'enabled' : 'disabled'}
</your_configuration>`;
}

export function buildWorkspaceInfoPrompt(input: WorkspaceInfoInput): string {
  if (input.sandboxIsolated && input.sandboxPath) {
    return `<workspace_info>
Your current workspace is located at: ${input.virtualWorkspacePath}
This is an isolated sandbox environment. Use ${input.virtualWorkspacePath} as the root path for file operations.
</workspace_info>`;
  }
  return input.workingDir
    ? `<workspace_info>Your current workspace is: ${input.workingDir}</workspace_info>`
    : '';
}

export function buildUserInstructionsPrompt(instructions?: string | null): string {
  return typeof instructions === 'string' && instructions.trim()
    ? `<user_instructions>
The user has provided the following personal instructions. Follow them consistently across the conversation:
${instructions.trim()}
</user_instructions>`
    : '';
}

/**
 * Assemble the SDK append block: static behavioral rules, the runtime-derived
 * sections and the injected context blocks, blank sections filtered out.
 */
export function buildCoworkAppendPrompt(input: CoworkAppendPromptInput): string {
  const sections: Array<string | null | undefined> = [
    COWORK_INTRODUCTION,
    COWORK_BEHAVIORAL_RULES,
    buildRuntimeConfigSummaryPrompt(input.config),
    buildWorkspaceInfoPrompt(input.workspace),
    buildUserInstructionsPrompt(input.coworkInstructions),
    `<citation_requirements>
If your answer uses linkable content from MCP tools, include a "Sources:" section and otherwise use standard Markdown links: [Title](https://claude.ai/chat/URL).
</citation_requirements>`,
    `<tool_behavior>
Tool routing:
- web_search and web_fetch are NATIVE built-in tools, always available. Use web_search for general lookups, then web_fetch to read a result in full.
- If user explicitly asks to use Chrome/browser/web navigation, prioritize Chrome MCP tools (mcp__Chrome__*) over the native web tools.
</tool_behavior>`,
    readString(input.elitePrompt),
    readString(input.strategicPrompt),
    readString(input.bundledPathHints),
    readString(input.extensionSystemContext),
    readString(input.projectSystemPromptBlock),
    readString(input.userPreferences),
    readString(input.errorPatterns),
    readString(input.projectResumption),
  ];

  return sections
    .filter((section): section is string => Boolean(section && section.trim()))
    .join('\n\n');
}
