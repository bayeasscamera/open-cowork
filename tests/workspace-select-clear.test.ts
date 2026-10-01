import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Workspace select / clear / project-follow.
 *
 * Two reported UX gaps:
 *  1. No way to remove the chosen workspace folder and leave it empty.
 *  2. Clicking a project does not take its folder as the workspace, even
 *     though new sessions already start in project.workdir.
 */

const mainIndex = readFileSync('src/main/index.ts', 'utf8');
const useIPC = readFileSync('src/renderer/hooks/useIPC.ts', 'utf8');
const welcome = readFileSync('src/renderer/components/WelcomeView.tsx', 'utf8');
const contextPanel = readFileSync('src/renderer/components/ContextPanel.tsx', 'utf8');
const sidebar = readFileSync('src/renderer/components/Sidebar.tsx', 'utf8');

describe('clearing the workspace', () => {
  it('main clears the UI workspace on an empty path (session cwd untouched)', () => {
    expect(mainIndex).toContain('Working directory cleared (UI/no workspace)');
    expect(mainIndex).toContain('Cannot clear the directory of an existing session');
  });

  it('useIPC exposes direct set + clear helpers', () => {
    expect(useIPC).toContain('setWorkingDirPath');
    expect(useIPC).toContain('clearWorkingDir');
    expect(useIPC).toContain("type: 'workdir.set'");
  });

  it('WelcomeView offers a clear (X) button next to the chosen folder', () => {
    expect(welcome).toContain('clearWorkingDir()');
    expect(welcome).toContain("t('welcome.clearWorkspace')");
  });

  it('ContextPanel offers clearing only for the global workspace, never a live session', () => {
    expect(contextPanel).toContain('!activeSessionId && currentWorkingDir');
    expect(contextPanel).toContain("t('context.clearWorkspace')");
  });
});

describe('project click follows its folder', () => {
  it('activating a project in the sidebar points the UI workspace at its workdir', () => {
    expect(sidebar).toContain('setWorkingDirPath(project.workdir)');
    expect(sidebar).toContain('setActiveProjectId(project.id)');
  });
});
