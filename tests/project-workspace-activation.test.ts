import { describe, expect, it, vi } from 'vitest';
import type { GlobalNotice } from '../src/renderer/store';
import {
  applyProjectWorkspaceActivation,
  type ProjectWorkspaceActivationDependencies,
} from '../src/renderer/utils/project-workspace-activation';

interface Notice extends GlobalNotice {
  type: 'error';
  messageKey: string;
  messageValues: Record<string, string>;
}

function createDependencies(
  overrides: Partial<ProjectWorkspaceActivationDependencies> = {}
): ProjectWorkspaceActivationDependencies & {
  activeProjectId: string | null;
  notices: Notice[];
  setWorkingDirPath: ReturnType<typeof vi.fn>;
} {
  const dependencies = {
    activeProjectId: 'previous-project',
    notices: [] as Notice[],
    getActiveProjectId(): string | null {
      return dependencies.activeProjectId;
    },
    setActiveProjectId(projectId: string | null): void {
      dependencies.activeProjectId = projectId;
    },
    setWorkingDirPath: vi.fn(async () => ({ success: true, path: '/projects/next' })),
    notify(notice: Notice): void {
      dependencies.notices.push(notice);
    },
    now: () => 1700000000000,
    ...overrides,
  };

  return dependencies;
}

const project = {
  id: 'next-project',
  name: 'Next project',
  workdir: '/projects/next',
  isArchived: false,
};

describe('project workspace activation', () => {
  it('updates the displayed workspace after activating an expanded project', async () => {
    const dependencies = createDependencies();

    const result = await applyProjectWorkspaceActivation({ project, expanded: true, dependencies });

    expect(result).toBe('activated');
    expect(dependencies.activeProjectId).toBe('next-project');
    expect(dependencies.setWorkingDirPath).toHaveBeenCalledWith('/projects/next');
    expect(dependencies.notices).toEqual([]);
  });

  it('clears the active project when collapsing it', async () => {
    const dependencies = createDependencies({ activeProjectId: 'next-project' });

    const result = await applyProjectWorkspaceActivation({
      project,
      expanded: false,
      dependencies,
    });

    expect(result).toBe('deactivated');
    expect(dependencies.activeProjectId).toBeNull();
    expect(dependencies.setWorkingDirPath).not.toHaveBeenCalled();
  });

  it('leaves unrelated active projects unchanged when collapsing another project', async () => {
    const dependencies = createDependencies();

    const result = await applyProjectWorkspaceActivation({
      project,
      expanded: false,
      dependencies,
    });

    expect(result).toBe('ignored');
    expect(dependencies.activeProjectId).toBe('previous-project');
    expect(dependencies.setWorkingDirPath).not.toHaveBeenCalled();
  });

  it('reverts activation and notifies when the workspace display cannot follow', async () => {
    const dependencies = createDependencies({
      setWorkingDirPath: vi.fn(async () => ({
        success: false,
        path: '/projects/next',
        error: 'Directory does not exist',
      })),
    });

    const result = await applyProjectWorkspaceActivation({ project, expanded: true, dependencies });

    expect(result).toBe('reverted');
    expect(dependencies.activeProjectId).toBe('previous-project');
    expect(dependencies.notices).toHaveLength(1);
    expect(dependencies.notices[0]).toMatchObject({
      id: 'workspace-activation-next-project-1700000000000',
      type: 'error',
      messageKey: 'projects.errors.workspaceActivationFailed',
      messageValues: {
        project: 'Next project',
        reason: 'Directory does not exist',
      },
    });
  });

  it('reverts activation when workspace synchronization itself rejects', async () => {
    const dependencies = createDependencies({
      setWorkingDirPath: vi.fn(async () => {
        throw new Error('IPC timeout');
      }),
    });

    const result = await applyProjectWorkspaceActivation({ project, expanded: true, dependencies });

    expect(result).toBe('reverted');
    expect(dependencies.activeProjectId).toBe('previous-project');
    expect(dependencies.notices[0]?.messageValues.reason).toBe('IPC timeout');
  });
});
