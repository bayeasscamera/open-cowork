/**
 * @module main/agent/mcp-servers-config
 *
 * Builds the SDK `mcpServers` payload (and its fingerprint cache) for a query.
 *
 * Extracted from CoworkAgentRunner.run(). The runner injects the MCP manager,
 * the config store and the bundled-node resolver, so this module owns no
 * singleton state: it only reads config, resolves bundled binaries and logs
 * what it built.
 */

import * as path from 'path';
import type { MCPServerConfig, MCPManager } from '../mcp/mcp-manager';
import type { getBundledNodePaths } from './bundled-binaries';
import { log, logWarn, logError } from '../utils/logger';
import { safeStringify, toErrorText } from './agent-runner-formatting';

/** Memoized SDK `mcpServers` payload plus the fingerprint it was built from. */
export interface McpServersCache {
  fingerprint: string;
  servers: Record<string, unknown>;
}

/** Minimal surface of the MCP config store this builder needs. */
export interface McpConfigStoreLike {
  getEnabledServers(): MCPServerConfig[];
  createFromPreset(presetKey: string, enabled?: boolean): MCPServerConfig | null;
}

export interface McpServersConfigDeps {
  /** Connected MCP manager; when absent the builder returns an empty payload. */
  mcpManager: Pick<MCPManager, 'getServerStatus'> | undefined;
  configStore: McpConfigStoreLike;
  getBundledNodePaths: typeof getBundledNodePaths;
}

export interface BuildMcpServersConfigOptions {
  deps: McpServersConfigDeps;
  /** Whether the active model accepts image tool output. */
  imageCapable: boolean;
  /** Result of the previous build; reused when its fingerprint still matches. */
  cache: McpServersCache | null;
}

export interface McpServersConfigResult {
  /** SDK `mcpServers` payload — `{}` when MCP is disabled for the run. */
  servers: Record<string, unknown>;
  /** Cache to store for the next query; left untouched when MCP is disabled. */
  cache: McpServersCache | null;
}

export function buildMcpServersConfig(
  options: BuildMcpServersConfigOptions
): McpServersConfigResult {
  const { mcpManager, configStore, getBundledNodePaths: resolveBundledNodePaths } = options.deps;
  const { imageCapable } = options;
  const previousCache = options.cache;
  let nextCache = options.cache;

  // Build MCP servers configuration for SDK
  // IMPORTANT: SDK uses tool names in format: mcp__<ServerKey>__<toolName>
  const mcpServers: Record<string, unknown> = {};
  if (mcpManager) {
    const serverStatuses = mcpManager.getServerStatus();
    const connectedServers = serverStatuses.filter((s) => s.connected);
    log('[CoworkAgentRunner] MCP server statuses:', safeStringify(serverStatuses));
    log('[CoworkAgentRunner] Connected MCP servers:', connectedServers.length);

    let allConfigs: MCPServerConfig[] = [];
    try {
      allConfigs = configStore.getEnabledServers();
      log(
        '[CoworkAgentRunner] Enabled MCP configs:',
        allConfigs.map((c) => c.name)
      );
    } catch (error) {
      logWarn(
        '[CoworkAgentRunner] Failed to read enabled MCP configs; MCP tools will be unavailable this query',
        error
      );
      allConfigs = [];
    }

    // Cache key: serialized config list + imageCapable flag.  The bundled node
    // paths are stable for the lifetime of the process so they don't need to be
    // part of the fingerprint.
    const mcpFingerprint = JSON.stringify(allConfigs) + String(imageCapable);
    if (previousCache?.fingerprint === mcpFingerprint) {
      Object.assign(mcpServers, previousCache.servers);
      log('[CoworkAgentRunner] MCP servers config reused from cache');
    } else {
      // Use the module-level memoized helper — no more per-query fs.existsSync calls.
      const bundledNodePaths = resolveBundledNodePaths();
      const bundledNpx = bundledNodePaths?.npx ?? null;

      for (const config of allConfigs) {
        try {
          // Use a simpler key without spaces to avoid issues
          const serverKey = config.name;

          if (config.type === 'stdio') {
            // 当命令是 npx 或 node 时优先使用内置路径
            const command =
              config.command === 'npx' && bundledNpx
                ? bundledNpx
                : config.command === 'node' && bundledNodePaths
                  ? bundledNodePaths.node
                  : config.command;

            // 使用内置 npx/node 时，将内置 node bin 注入 PATH
            const serverEnv = { ...config.env };
            if (bundledNodePaths && (config.command === 'npx' || config.command === 'node')) {
              const nodeBinDir = path.dirname(bundledNodePaths.node);
              const currentPath = process.env.PATH || '';
              // Prepend bundled node bin to PATH so npx can find node
              serverEnv.PATH = `${nodeBinDir}${path.delimiter}${currentPath}`;
              log(`[CoworkAgentRunner]   Added bundled node bin to PATH: ${nodeBinDir}`);
            }

            if (!imageCapable) {
              serverEnv.OPEN_COWORK_DISABLE_IMAGE_TOOL_OUTPUT = '1';
            }

            // Resolve path placeholders for presets
            let resolvedArgs = config.args || [];

            // Check if any args contain placeholders that need resolving
            const hasPlaceholders = resolvedArgs.some(
              (arg) =>
                arg.includes('{SOFTWARE_DEV_SERVER_PATH}') ||
                arg.includes('{GUI_OPERATE_SERVER_PATH}')
            );

            if (hasPlaceholders) {
              // Get the appropriate preset based on config name
              let presetKey: string | null = null;
              if (
                config.name === 'Software_Development' ||
                config.name === 'Software Development'
              ) {
                presetKey = 'software-development';
              } else if (config.name === 'GUI_Operate' || config.name === 'GUI Operate') {
                presetKey = 'gui-operate';
              }

              if (presetKey) {
                const preset = configStore.createFromPreset(presetKey, true);
                if (preset && preset.args) {
                  resolvedArgs = preset.args;
                }
              }
            }

            mcpServers[serverKey] = {
              type: 'stdio',
              command,
              args: resolvedArgs,
              env: serverEnv,
            };
            log(`[CoworkAgentRunner] Added STDIO MCP server: ${serverKey}`);
            log(`[CoworkAgentRunner]   Command: ${command} ${resolvedArgs.join(' ')}`);
            log(`[CoworkAgentRunner]   Tools will be named: mcp__${serverKey}__<toolName>`);
          } else if (config.type === 'sse') {
            mcpServers[serverKey] = {
              type: 'sse',
              url: config.url,
              headers: config.headers || {},
            };
            log(`[CoworkAgentRunner] Added SSE MCP server: ${serverKey}`);
          }
        } catch (error) {
          logError('[CoworkAgentRunner] Failed to prepare MCP server config, skipping server', {
            serverId: config.id,
            serverName: config.name,
            error: toErrorText(error),
          });
        }
      }

      // Store in cache for subsequent queries
      nextCache = { fingerprint: mcpFingerprint, servers: { ...mcpServers } };
    }

    const mcpServersSummary = Object.entries(mcpServers).map(([name, serverConfig]) => {
      const typedServerConfig = serverConfig as {
        type?: string;
        command?: string;
        args?: unknown[];
        env?: Record<string, unknown>;
      };
      return {
        name,
        type: typedServerConfig.type ?? 'unknown',
        command: typedServerConfig.command ?? '',
        argsCount: Array.isArray(typedServerConfig.args) ? typedServerConfig.args.length : 0,
        envKeys: typedServerConfig.env ? Object.keys(typedServerConfig.env).length : 0,
      };
    });
    log('[CoworkAgentRunner] Final mcpServers summary:', safeStringify(mcpServersSummary, 2));
    if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {
      log('[CoworkAgentRunner] Final mcpServers config:', safeStringify(mcpServers, 2));
    }
  }
  return { servers: mcpServers, cache: nextCache };
}
