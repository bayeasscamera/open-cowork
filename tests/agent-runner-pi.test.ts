import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const agentRunnerPath = path.resolve(process.cwd(), 'src/main/agent/agent-runner.ts');
const agentRunnerContent = readFileSync(agentRunnerPath, 'utf8');
const formattingPath = path.resolve(process.cwd(), 'src/main/agent/agent-runner-formatting.ts');
const formattingContent = readFileSync(formattingPath, 'utf8');
const mcpToolsPath = path.resolve(process.cwd(), 'src/main/agent/agent-runner-mcp-tools.ts');
const mcpToolsContent = readFileSync(mcpToolsPath, 'utf8');
const coldStartHistoryPath = path.resolve(process.cwd(), 'src/main/agent/cold-start-history.ts');
const coldStartHistoryContent = readFileSync(coldStartHistoryPath, 'utf8');
const mcpServersConfigPath = path.resolve(process.cwd(), 'src/main/agent/mcp-servers-config.ts');
const mcpServersConfigContent = readFileSync(mcpServersConfigPath, 'utf8');
const runtimeConfigSummaryPath = path.resolve(
  process.cwd(),
  'src/main/agent/runtime-config-summary.ts'
);
const runtimeConfigSummaryContent = readFileSync(runtimeConfigSummaryPath, 'utf8');
const sessionEventLoggingPath = path.resolve(
  process.cwd(),
  'src/main/agent/session-event-logging.ts'
);
const sessionEventLoggingContent = readFileSync(sessionEventLoggingPath, 'utf8');
const sessionEventHandlerPath = path.resolve(
  process.cwd(),
  'src/main/agent/session-event-handler.ts'
);
const sessionEventHandlerContent = readFileSync(sessionEventHandlerPath, 'utf8');
const createPiSessionPath = path.resolve(process.cwd(), 'src/main/agent/create-pi-session.ts');
const createPiSessionContent = readFileSync(createPiSessionPath, 'utf8');
const piSessionToolsPath = path.resolve(process.cwd(), 'src/main/agent/pi-session-tools.ts');
const piSessionToolsContent = readFileSync(piSessionToolsPath, 'utf8');
const piSessionLifecyclePath = path.resolve(
  process.cwd(),
  'src/main/agent/pi-session-lifecycle.ts'
);
const piSessionLifecycleContent = readFileSync(piSessionLifecyclePath, 'utf8');

describe('CoworkAgentRunner Open Cowork SDK integration', () => {
  it('avoids dynamic re-import shadowing for config store singletons', () => {
    expect(agentRunnerContent).toContain(
      "import { mcpConfigStore } from '../mcp/mcp-config-store'"
    );
    expect(agentRunnerContent).not.toContain(
      "const { configStore } = await import('../config/config-store')"
    );
    expect(agentRunnerContent).not.toContain(
      "const { mcpConfigStore } = await import('../mcp/mcp-config-store')"
    );
  });

  it('keeps MCP config build resilient', () => {
    // The resilient serializer now lives in the formatting module
    expect(agentRunnerContent).toContain("from './agent-runner-formatting'");
    expect(formattingContent).toContain('function safeStringify');
    // The MCP payload build now lives in its own module; the guard follows it.
    expect(mcpServersConfigContent).toContain(
      'Failed to prepare MCP server config, skipping server'
    );
    expect(agentRunnerContent).toContain('buildMcpServersConfig({');
  });

  it('uses standard markdown link guidance for sources citations', () => {
    // The append-system-prompt templates now live in their own module; the guard follows them.
    expect(runtimeConfigSummaryContent).toContain(
      'otherwise use standard Markdown links: [Title](https://claude.ai/chat/URL)'
    );
  });

  it('avoids duplicating the current user prompt in contextual history assembly', () => {
    // The cold-start assembly now lives in its own module; the guard follows it.
    expect(coldStartHistoryContent).toContain(
      'const conversationMessages = options.messages.filter('
    );
    // Image-containing messages are filtered out individually (not skipping entire history)
    expect(coldStartHistoryContent).toContain('const textOnlyMessages = conversationMessages');
    expect(coldStartHistoryContent).toContain('textOnlyMessages.slice(0, -1)');
    expect(coldStartHistoryContent).toContain(
      "textOnlyMessages[textOnlyMessages.length - 1]?.role === 'user'"
    );
  });

  it('keeps MCP server logging compact unless full debug logging is enabled', () => {
    expect(mcpServersConfigContent).toContain(
      "log('[CoworkAgentRunner] Final mcpServers summary:'"
    );
    expect(mcpServersConfigContent).toContain(
      "if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {"
    );
    expect(mcpServersConfigContent).toContain("log('[CoworkAgentRunner] Final mcpServers config:'");
  });

  it('summarizes noisy SDK message updates instead of logging every text delta', () => {
    // Event classification now lives in session-event-logging; the guard follows it.
    expect(agentRunnerContent).toContain('logSessionStreamEvent(event, sessionEventLoggingDeps);');
    expect(sessionEventLoggingContent).toContain('deps.telemetry.recordStreamEvent(updateType);');
    expect(sessionEventLoggingContent).toContain(
      "const QUIET_UPDATE_TYPES = new Set(['text_delta', 'thinking_delta']);"
    );
    expect(sessionEventLoggingContent).toContain('if (!QUIET_UPDATE_TYPES.has(updateType)) {');
    expect(sessionEventLoggingContent).toContain("'[CoworkAgentRunner] Event: message_end'");
    expect(sessionEventLoggingContent).toContain(
      'messageUpdateCounts: deps.telemetry.getStreamEventSummary()'
    );
    // The raw-message dump now lives in session-event-handler, gated on full debug logging.
    expect(sessionEventHandlerContent).toContain(
      "if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {"
    );
    expect(sessionEventHandlerContent).toContain("'[CoworkAgentRunner] message_end raw message:'");
  });

  it('reuses the shared user-facing error helper', () => {
    expect(agentRunnerContent).toContain("from './agent-runner-message-end'");
    expect(sessionEventHandlerContent).toContain('resolveMessageEndPayload');
    expect(agentRunnerContent).toContain('toUserFacingErrorText');
    // Thrown provider errors are classified centrally; retryable ones (429 /
    // gateway 5xx) are held back for the session-manager fallback, terminal
    // ones are published immediately — both through the shared helper.
    expect(agentRunnerContent).toContain('const thrownText = toErrorText(error);');
    expect(agentRunnerContent).toContain('toUserFacingErrorText(thrownText)');
  });

  it('uses pi DefaultResourceLoader with additionalSkillPaths and appendSystemPrompt', () => {
    // Session construction now lives in create-pi-session.ts
    expect(createPiSessionContent).toContain('additionalSkillPaths: deps.skillPaths');
    // appendSystemPrompt takes a string[] since pi-coding-agent 0.73.
    expect(createPiSessionContent).toContain('appendSystemPrompt: [deps.coworkAppendPrompt]');
    expect(createPiSessionContent).not.toContain('systemPromptOverride');
    expect(agentRunnerContent).not.toContain('systemPromptOverride');
  });

  it('recreates cached pi sessions when the runtime signature changes', () => {
    expect(agentRunnerContent).toContain(
      "import { buildPiSessionRuntimeSignature } from './pi-session-runtime'"
    );
    expect(agentRunnerContent).toContain(
      'const sessionRuntimeSignature = buildPiSessionRuntimeSignature({'
    );
    // The comparison and its log wording moved to the lifecycle module; the
    // runner only wires the freshly resolved signatures in.
    expect(piSessionLifecycleContent).toContain(
      'cachedSession.runtimeSignature !== current.runtimeSignature'
    );
    expect(piSessionLifecycleContent).toContain('Runtime changed, recreating cached pi session:');
    expect(agentRunnerContent).toContain('runtimeSignature: sessionRuntimeSignature');
    expect(agentRunnerContent).toContain('resolvePiSessionRecreateReason(cachedSession, {');
  });

  it('uses the normalized route protocol so openrouter follows the openai-compatible path', () => {
    expect(agentRunnerContent).toContain('resolvePiRouteProtocol');
    expect(agentRunnerContent).toContain('const configProtocol = resolvePiRouteProtocol(');
    expect(agentRunnerContent).toContain('resolveSyntheticPiModelFallback');
  });

  it('nudges the model to proceed with reasonable assumptions', () => {
    expect(runtimeConfigSummaryContent).toContain(
      'proceed immediately with reasonable assumptions'
    );
    expect(runtimeConfigSummaryContent).toContain('within two days');
    expect(runtimeConfigSummaryContent).toContain('most recent two relevant publication days');
  });

  it('routes MCP image results through structured helpers instead of stringifying base64 into text', () => {
    // The MCP bridge now lives in agent-runner-mcp-tools.ts; assembly in pi-session-tools.ts
    expect(piSessionToolsContent).toContain("from './agent-runner-mcp-tools'");
    expect(piSessionToolsContent).toContain('buildMcpCustomTools(deps.mcpManager)');
    expect(mcpToolsContent).toContain(
      "import { normalizeMcpToolResultForModel } from './tool-result-utils'"
    );
    expect(mcpToolsContent).toContain(
      'const normalizedResult = normalizeMcpToolResultForModel(result);'
    );
    expect(sessionEventHandlerContent).toContain(
      'const normalizedToolResult = normalizeToolExecutionResultForUi(event.result);'
    );
    expect(agentRunnerContent).not.toContain('else textParts.push(JSON.stringify(part));');
    expect(agentRunnerContent).not.toContain(": JSON.stringify(event.result || '');");
  });

  it('persists assistant model metadata for pi-ai thinking replay', () => {
    expect(agentRunnerContent).toContain('api: piModel.api');
    expect(agentRunnerContent).toContain('provider: piModel.provider');
    expect(agentRunnerContent).toContain('model: piModel.id');
  });

  it('does not reference removed AskUserQuestion or TodoWrite tools', () => {
    expect(agentRunnerContent).not.toContain('AskUserQuestion');
    expect(agentRunnerContent).not.toContain('TodoWrite');
    expect(agentRunnerContent).not.toContain('pendingQuestions');
  });

  it('chat-first behavioral rules are present', () => {
    expect(runtimeConfigSummaryContent).toContain('CHAT FIRST');
    expect(runtimeConfigSummaryContent).toContain(
      'Do NOT create, write, or edit files unless the user explicitly asks'
    );
    expect(runtimeConfigSummaryContent).toContain('START DOING IT');
    // The runner keeps wiring the assembled block into the pi session.
    expect(agentRunnerContent).toContain('const coworkAppendPrompt = buildCoworkAppendPrompt({');
  });
});
