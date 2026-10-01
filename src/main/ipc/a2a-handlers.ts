/**
 * @module main/ipc/a2a-handlers
 *
 * Agent-to-Agent server controls (`a2a.*`): status, enable/disable and token
 * management. The server itself lives in `main/a2a/`; starting and stopping
 * stays in `main/index.ts` (it owns the SessionManager), reached through the
 * `refreshA2AServer` context callback.
 */
import { ipcMain } from 'electron';
import * as crypto from 'crypto';
import { configStore } from '../config/config-store';
import { log, logError } from '../utils/logger';
import { A2A_HOST } from '../a2a/a2a-server';
import type { A2AStatus } from '../../shared/types';

/** Accessors for app-level state owned by main/index.ts. */
export interface A2AIpcContext {
  refreshA2AServer(): { running: boolean; url: string };
  isA2ARunning(): boolean;
}

function maskToken(token: string): string {
  if (!token) return '';
  return `••••${token.slice(-4)}`;
}

export function buildA2AStatus(running: boolean): A2AStatus {
  const config = configStore.getAll();
  return {
    enabled: config.a2aEnabled,
    running,
    port: config.a2aPort,
    url: `http://${A2A_HOST}:${config.a2aPort}`,
    hasToken: Boolean(config.a2aToken),
    tokenPreview: maskToken(config.a2aToken),
  };
}

export function registerA2AIpcHandlers(context: A2AIpcContext): void {
  ipcMain.handle('a2a.getStatus', (): A2AStatus => {
    try {
      return buildA2AStatus(context.isA2ARunning());
    } catch (error) {
      logError('[A2A] Error getting status:', error);
      throw error;
    }
  });

  ipcMain.handle('a2a.setEnabled', (_event, enabled: boolean): A2AStatus => {
    try {
      const updates: { a2aEnabled: boolean; a2aToken?: string } = {
        a2aEnabled: Boolean(enabled),
      };
      if (enabled && !configStore.get('a2aToken')) {
        updates.a2aToken = crypto.randomBytes(32).toString('hex');
        log('[A2A] Generated bearer token on first enable.');
      }
      configStore.update(updates);
      const { running } = context.refreshA2AServer();
      return buildA2AStatus(running);
    } catch (error) {
      logError('[A2A] Error setting enabled:', error);
      throw error;
    }
  });

  ipcMain.handle('a2a.regenerateToken', (): { token: string; status: A2AStatus } => {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      configStore.update({ a2aToken: token });
      const { running } = context.refreshA2AServer();
      log('[A2A] Bearer token regenerated; old token is invalid.');
      return { token, status: buildA2AStatus(running) };
    } catch (error) {
      logError('[A2A] Error regenerating token:', error);
      throw error;
    }
  });
}
