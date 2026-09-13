/**
 * @module main/ipc/ipc-router
 * Modular IPC Routing & Dispatch Architecture
 *
 * Refactors monolithic event handlers away from index.ts into cohesive domain modules.
 */

import { ipcMain } from 'electron';
import { log, logError } from '../utils/logger';

export type IPCHandlerFn = (
  event: Electron.IpcMainEvent,
  ...args: unknown[]
) => Promise<unknown> | unknown;

export type IPCInvokeHandlerFn = (
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown> | unknown;

export class IPCRouter {
  private static registeredChannels: Set<string> = new Set();

  public static register(channel: string, handler: IPCHandlerFn): void {
    if (this.registeredChannels.has(channel)) {
      log(`[IPCRouter] Replacing existing handler for channel: ${channel}`);
      ipcMain.removeAllListeners(channel);
    }

    ipcMain.on(channel, async (event, ...args) => {
      try {
        await handler(event, ...args);
      } catch (err: unknown) {
        logError(`[IPCRouter] Error executing handler on channel '${channel}':`, err);
      }
    });

    this.registeredChannels.add(channel);
  }

  public static handle(channel: string, handler: IPCInvokeHandlerFn): void {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args);
      } catch (err: unknown) {
        logError(`[IPCRouter] Error in invoke handler for '${channel}':`, err);
        throw err;
      }
    });
  }

  public static listChannels(): string[] {
    return Array.from(this.registeredChannels);
  }
}
