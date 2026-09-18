import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const preloadPath = path.resolve(process.cwd(), 'src/preload/index.ts');
const mainPath = path.resolve(process.cwd(), 'src/main/index.ts');

describe('logs.write IPC contract', () => {
  it('preload sends the arguments as a single array, not spread IPC params', () => {
    const source = readFileSync(preloadPath, 'utf8');
    expect(source).toContain("ipcRenderer.invoke('logs.write', level, args)");
    expect(source).not.toContain("ipcRenderer.invoke('logs.write', level, ...args)");
  });

  it('main handler unpacks the args array and keeps the IPC call exception-free', () => {
    const source = readFileSync(mainPath, 'utf8');
    expect(source).toContain(
      "ipcMain.handle('logs.write', (_event, level: unknown, ...rest: unknown[]) => {"
    );
    expect(source).toContain('rest.length === 1 && Array.isArray(rest[0])');
    expect(source).toContain('logWarn(...entries)');
    expect(source).toContain('logError(...entries)');
  });
});
