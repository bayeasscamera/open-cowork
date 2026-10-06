/**
 * @module main/agent/agent-runner-mcp-tools
 *
 * Bridge MCP tools from MCPManager into the agent SDK's ToolDefinition format.
 * Extracted from CoworkAgentRunner so the delegation and error handling can be
 * tested without an Electron runtime.
 */

import { Type, type TSchema } from 'typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { MCPManager } from '../mcp/mcp-manager';
import { normalizeMcpToolResultForModel } from './tool-result-utils';
import { checkMcpSchema, describeMcpSchemaRefusal } from './mcp-schema-guard';
import { logError, logWarn } from '../utils/logger';

/**
 * Bridge MCP tools from MCPManager into ToolDefinition[] format for the agent SDK.
 * Each MCP tool becomes a customTool whose execute() delegates to mcpManager.callTool().
 */
export function buildMcpCustomTools(mcpManager: MCPManager): ToolDefinition[] {
  const mcpTools = mcpManager.getTools();
  const tools: ToolDefinition[] = [];
  for (const mcpTool of mcpTools) {
    // The schema comes from a third party and AJV compiles whatever it is
    // given, so it is checked BEFORE it becomes a tool. A refusal drops the
    // tool rather than its schema: a schema-less tool cannot be validated at
    // all, which is worse than not offering the tool.
    const refusal = checkMcpSchema(mcpTool.inputSchema);
    if (refusal) {
      logWarn('[MCP] ' + describeMcpSchemaRefusal(mcpTool.serverName, mcpTool.name, refusal));
      continue;
    }
    // Wrap the raw JSON Schema inputSchema as a TypeBox TSchema
    const parameters = Type.Unsafe<Record<string, unknown>>(
      mcpTool.inputSchema as Record<string, unknown>
    );

    const toolDef: ToolDefinition<TSchema, unknown> = {
      name: mcpTool.name,
      label: `${mcpTool.serverName} → ${mcpTool.originalName || mcpTool.name}`,
      description: mcpTool.description || `MCP tool from ${mcpTool.serverName}`,
      parameters,
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        try {
          const result = await mcpManager.callTool(mcpTool.name, params as Record<string, unknown>);
          const normalizedResult = normalizeMcpToolResultForModel(result);
          return {
            content: [{ type: 'text' as const, text: normalizedResult.text }],
            details:
              normalizedResult.images.length > 0
                ? { openCoworkImages: normalizedResult.images }
                : undefined,
          };
        } catch (err: unknown) {
          logError(`[CoworkAgentRunner] MCP tool ${mcpTool.name} failed:`, err);
          throw err instanceof Error ? err : new Error(String(err));
        }
      },
    };
    tools.push(toolDef);
  }
  return tools;
}
