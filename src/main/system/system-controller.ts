/**
 * @module main/system/system-controller
 *
 * Pilier 1 — Omnipotence Système & Contrôle Machine (OpenClaw / OS-level control)
 *
 * Provides safe, native machine control capabilities for macOS and Windows:
 * - App management (launch, focus, quit via open -a / osascript / PowerShell)
 * - Clipboard inspection and manipulation (Electron clipboard or pbcopy/pbpaste)
 * - Native OS notifications
 * - Process inspection and termination
 * - Safe AppleScript & JXA execution on macOS
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { clipboard, Notification } from 'electron';
import { logError } from '../utils/logger';

const execAsync = promisify(exec);

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu?: string;
  mem?: string;
  command?: string;
}

export class SystemController {
  private static instance: SystemController;

  private constructor() {}

  public static getInstance(): SystemController {
    if (!SystemController.instance) {
      SystemController.instance = new SystemController();
    }
    return SystemController.instance;
  }

  /**
   * Launch or bring to front an application by name (e.g. 'Safari', 'Terminal', 'Visual Studio Code')
   */
  async launchApp(appName: string): Promise<{ success: boolean; output: string }> {
    const isMac = process.platform === 'darwin';
    try {
      if (isMac) {
        // macOS open -a
        await execAsync(`open -a "${appName.replace(/"/g, '\\"')}"`);
        return { success: true, output: `Application "${appName}" launched and brought to foreground.` };
      } else if (process.platform === 'win32') {
        await execAsync(`powershell -Command "Start-Process '${appName.replace(/'/g, "''")}'"`);
        return { success: true, output: `Application "${appName}" started.` };
      } else {
        await execAsync(`nohup "${appName}" >/dev/null 2>&1 &`);
        return { success: true, output: `Application "${appName}" launched.` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[SystemController] Failed to launch app "${appName}":`, err);
      return { success: false, output: `Failed to launch app: ${msg}` };
    }
  }

  /**
   * Terminate an application gracefully or forcefully
   */
  async quitApp(appName: string, force = false): Promise<{ success: boolean; output: string }> {
    const isMac = process.platform === 'darwin';
    try {
      if (isMac) {
        if (force) {
          await execAsync(`pkill -9 -f "${appName.replace(/"/g, '\\"')}"`);
        } else {
          // AppleScript graceful quit
          const script = `tell application "${appName.replace(/"/g, '\\"')}" to quit`;
          await execAsync(`osascript -e '${script}'`);
        }
        return { success: true, output: `Application "${appName}" ${force ? 'force killed' : 'closed'}.` };
      } else if (process.platform === 'win32') {
        const flag = force ? '/F' : '';
        await execAsync(`taskkill /IM "${appName}.exe" ${flag}`);
        return { success: true, output: `Application "${appName}" terminated.` };
      } else {
        await execAsync(`pkill ${force ? '-9' : ''} -f "${appName}"`);
        return { success: true, output: `Application "${appName}" terminated.` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Could not quit app "${appName}": ${msg}` };
    }
  }

  /**
   * Clipboard read / write (Electron clipboard with CLI fallback for headless/Node environments)
   */
  readClipboard(): string {
    try {
      if (clipboard && typeof clipboard.readText === 'function') {
        const text = clipboard.readText();
        if (text) return text;
      }
    } catch {
      // fallback to CLI
    }

    try {
      if (process.platform === 'darwin') {
        return execSync('pbpaste', { encoding: 'utf-8', timeout: 3000 });
      } else if (process.platform === 'win32') {
        return execSync('powershell -Command "Get-Clipboard"', { encoding: 'utf-8', timeout: 3000 });
      }
    } catch {
      // ignore
    }
    return '';
  }

  writeClipboard(text: string): boolean {
    let electronOk = false;
    try {
      if (clipboard && typeof clipboard.writeText === 'function') {
        clipboard.writeText(text);
        electronOk = true;
      }
    } catch {
      electronOk = false;
    }

    if (electronOk) return true;

    try {
      if (process.platform === 'darwin') {
        execSync('pbcopy', { input: text, encoding: 'utf-8', timeout: 3000 });
        return true;
      } else if (process.platform === 'win32') {
        execSync(`powershell -Command "Set-Clipboard -Value '${text.replace(/'/g, "''")}'"`, { timeout: 3000 });
        return true;
      }
    } catch (err) {
      logError('[SystemController] Clipboard write fallback failed:', err);
    }
    return false;
  }

  /**
   * Native OS notification
   */
  notify(title: string, body: string): boolean {
    try {
      if (Notification.isSupported()) {
        const notif = new Notification({
          title: `Open Cowork: ${title}`,
          body,
          silent: false,
        });
        notif.show();
        return true;
      }
      return false;
    } catch (err) {
      logError('[SystemController] Notification failed:', err);
      return false;
    }
  }

  /**
   * List active processes with CPU and Memory info (top 30)
   */
  async listProcesses(filter?: string): Promise<ProcessInfo[]> {
    try {
      if (process.platform === 'darwin' || process.platform === 'linux') {
        const { stdout } = await execAsync('ps -eo pid,%cpu,%mem,comm | head -40');
        const lines = stdout.trim().split('\n').slice(1);
        const list: ProcessInfo[] = [];

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 4) {
            const pid = parseInt(parts[0], 10);
            const cpu = `${parts[1]}%`;
            const mem = `${parts[2]}%`;
            const name = parts.slice(3).join(' ');

            if (!filter || name.toLowerCase().includes(filter.toLowerCase())) {
              list.push({ pid, name, cpu, mem });
            }
          }
        }
        return list;
      } else {
        // Windows
        const { stdout } = await execAsync('powershell -Command "Get-Process | Select-Object -First 30 Id, ProcessName, CPU | ConvertTo-Json"');
        const parsed = JSON.parse(stdout);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        return items.map((p: { Id: number; ProcessName: string; CPU?: number }) => ({
          pid: p.Id,
          name: p.ProcessName,
          cpu: p.CPU ? `${p.CPU.toFixed(1)}s` : '0s',
        }));
      }
    } catch (err) {
      logError('[SystemController] Failed to list processes:', err);
      return [];
    }
  }

  /**
   * Kill process by PID
   */
  async killProcess(pid: number, force = false): Promise<{ success: boolean; output: string }> {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      return { success: true, output: `Process ${pid} terminated successfully.` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Failed to kill process ${pid}: ${msg}` };
    }
  }

  /**
   * Run AppleScript or JXA script on macOS
   */
  async runAppleScript(script: string): Promise<{ success: boolean; output: string }> {
    if (process.platform !== 'darwin') {
      return { success: false, output: 'AppleScript execution is only supported on macOS.' };
    }
    try {
      // Escape script safely
      const escapedScript = script.replace(/'/g, "'\\''");
      const { stdout, stderr } = await execAsync(`osascript -e '${escapedScript}'`, { timeout: 15_000 });
      return { success: true, output: (stdout || stderr || 'Script executed successfully.').trim() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `AppleScript execution failed: ${msg}` };
    }
  }
}
