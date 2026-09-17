import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readProjectFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('memory integration wiring', () => {
  it('registers the memory extension in the main process and exposes IPC handlers', () => {
    const mainIndex = readProjectFile('src/main/index.ts');
    expect(mainIndex).toContain('new MemoryExtension(memoryService)');
    expect(mainIndex).toContain("ipcMain.handle('memory.getOverview'");
    expect(mainIndex).toContain("'memory.search'");
    expect(mainIndex).toContain("'memory.listFiles'");
    expect(mainIndex).toContain("'memory.inspectSession'");
    expect(mainIndex).toContain("ipcMain.handle('memory.setEnabled'");
  });

  it('provides the local owner in headless mode without automatic deletion consent', () => {
    const mainIndex = readProjectFile('src/main/index.ts');
    const start = mainIndex.indexOf('memoryService = new MemoryService(db');
    const end = mainIndex.indexOf('const headlessExtensionManager', start);
    const initialization = mainIndex.slice(start, end);
    expect(initialization).toContain("owner: 'local-installation'");
    expect(initialization).toContain('!remoteManager.isRemoteSession(sessionId)');
    expect(initialization).toContain('db.sessions.get(sessionId)?.memory_enabled === 1');
    expect(initialization).not.toMatch(/confirmDelete\s*:/);
  });

  it('injects runtime plugin skill paths and extension hooks into the agent runner', () => {
    const runner = readProjectFile('src/main/agent/agent-runner.ts');
    const memoryExtension = readProjectFile('src/main/memory/memory-extension.ts');
    expect(runner).toContain('resolveSkillPaths(session.id)');
    expect(runner).toContain("path.join(plugin.runtimePath, 'skills')");
    expect(runner).toContain('this.extensionManager.beforeSessionRun');
    expect(runner).toContain('skillsSignature');
    expect(memoryExtension).toContain('customTools: this.memoryService.getTools(session)');
    expect(runner).toContain('extensionResult.systemContext');
    expect(runner).toContain('cachedSession.refreshMemoryContext');
  });

  it('adds a dedicated Memory settings tab and preload bridge', () => {
    const settingsPanel = readProjectFile('src/renderer/components/SettingsPanel.tsx');
    const preload = readProjectFile('src/preload/index.ts');
    const memorySettings = readProjectFile('src/renderer/components/settings/SettingsMemory.tsx');

    expect(settingsPanel).toContain("id: 'memory'");
    expect(settingsPanel).toContain('<SettingsMemory />');
    expect(preload).toContain('memory: {');
    expect(preload).toContain("ipcRenderer.invoke('memory.search'");
    expect(preload).toContain("ipcRenderer.invoke('memory.listFiles')");
    expect(memorySettings).toContain('window.electronAPI.memory.search');
    expect(memorySettings).toContain('window.electronAPI.memory.readFile');
    expect(memorySettings).toContain('window.electronAPI.memory.inspectSession');
    expect(memorySettings).toContain('window.electronAPI.memory.rebuildWorkspace');
    expect(memorySettings).toContain('evalEnabled: source.evalEnabled');
    expect(memorySettings).toContain('promptIterationRounds');
  });

  it('defaults new sessions to the global memory toggle', () => {
    const sessionManager = readProjectFile('src/main/session/session-manager.ts');
    expect(sessionManager).toContain("configStore.get('memoryEnabled') !== false");
    expect(sessionManager).toContain('memoryEnabled?: boolean');
    expect(sessionManager).toContain('afterSessionRun');
  });

  it('removes unused SQLite memory tables from schema initialization', () => {
    const databaseSource = readProjectFile('src/main/db/database.ts');
    expect(databaseSource).not.toContain('memory_core_entries');
    expect(databaseSource).not.toContain('memory_experience_sessions');
    expect(databaseSource).not.toContain('memory_experience_chunks');
    expect(databaseSource).not.toContain('memory_session_state');
  });
});
