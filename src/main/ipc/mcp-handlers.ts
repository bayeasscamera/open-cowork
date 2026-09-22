/**
 * @module main/ipc/mcp-handlers
 *
 * MCP server IPC channels (mcp.*). Extracted from main/index.ts so the channel
 * contract lives next to the other domain modules in main/ipc/ instead of
 * growing the app entry point.
 */

import { ipcMain } from 'electron';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import type { MCPManager, MCPServerConfig } from '../mcp/mcp-manager';
import { log, logError } from '../utils/logger';

/** Accessors for app-level state owned by main/index.ts. */
export interface McpIpcContext {
  getMcpManager(): MCPManager | null;
  invalidateMcpServersCache(): void;
}

export function registerMcpIpcHandlers(context: McpIpcContext): void {
  ipcMain.handle('mcp.getServers', () => {
    try {
      return mcpConfigStore.getServers();
    } catch (error) {
      logError('[MCP] Error getting servers:', error);
      return [];
    }
  });

  ipcMain.handle('mcp.getServer', (_event, serverId: string) => {
    try {
      return mcpConfigStore.getServer(serverId);
    } catch (error) {
      logError('[MCP] Error getting server:', error);
      return null;
    }
  });

  ipcMain.handle('mcp.saveServer', async (_event, config: MCPServerConfig) => {
    mcpConfigStore.saveServer(config);
    // Update only this specific server, not all servers
    const mcpManager = context.getMcpManager();
    if (mcpManager) {
      try {
        await mcpManager.updateServer(config);
        context.invalidateMcpServersCache();
        log(`[MCP] Server ${config.name} updated successfully`);
      } catch (err) {
        logError('[MCP] Failed to update server:', err);
        // Roll back: save the config with enabled=false so a broken connector
        // is not retried on next app startup
        if (config.enabled) {
          mcpConfigStore.saveServer({ ...config, enabled: false });
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, error: errorMessage };
      }
    }
    return { success: true };
  });

  ipcMain.handle('mcp.deleteServer', async (_event, serverId: string) => {
    mcpConfigStore.deleteServer(serverId);
    // Remove and disconnect only this specific server
    const mcpManager = context.getMcpManager();
    if (mcpManager) {
      try {
        await mcpManager.removeServer(serverId);
        context.invalidateMcpServersCache();
        log(`[MCP] Server ${serverId} removed successfully`);
      } catch (err) {
        logError('[MCP] Failed to remove server:', err);
      }
    }
    return { success: true };
  });

  ipcMain.handle('mcp.getTools', () => {
    try {
      const mcpManager = context.getMcpManager();
      return mcpManager ? mcpManager.getTools() : [];
    } catch (error) {
      logError('[MCP] Error getting tools:', error);
      return [];
    }
  });

  ipcMain.handle('mcp.getServerStatus', () => {
    try {
      const mcpManager = context.getMcpManager();
      return mcpManager ? mcpManager.getServerStatus() : [];
    } catch (error) {
      logError('[MCP] Error getting server status:', error);
      return [];
    }
  });

  ipcMain.handle('mcp.getPresets', () => {
    try {
      return mcpConfigStore.getPresets();
    } catch (error) {
      logError('[MCP] Error getting presets:', error);
      return {};
    }
  });
}
