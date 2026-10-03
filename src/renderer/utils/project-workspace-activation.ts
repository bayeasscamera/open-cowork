import type { GlobalNotice } from '../store';

export interface WorkspaceActivationProject {
  id: string;
  name: string;
  workdir: string;
  isArchived: boolean;
}

export interface WorkspaceDisplayResult {
  success: boolean;
  path: string;
  error?: string;
}

export interface WorkspaceActivationNotice extends Pick<
  GlobalNotice,
  'id' | 'type' | 'messageKey' | 'messageValues'
> {
  type: 'error';
  messageKey: string;
  messageValues: Record<string, string>;
}

export interface ProjectWorkspaceActivationDependencies {
  getActiveProjectId: () => string | null;
  setActiveProjectId: (projectId: string | null) => void;
  setWorkingDirPath: (path: string) => Promise<WorkspaceDisplayResult>;
  notify: (notice: GlobalNotice) => void;
  now?: () => number;
}

export type ProjectWorkspaceActivationResult = 'activated' | 'deactivated' | 'ignored' | 'reverted';

interface ActivationRequest {
  project: WorkspaceActivationProject;
  expanded: boolean;
  dependencies: ProjectWorkspaceActivationDependencies;
}

function activationFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Workspace display synchronization failed';
}

/**
 * Keep the active project and displayed workspace consistent.
 *
 * A project is conceptually selected before the main process confirms that the
 * UI workspace can follow it. If that confirmation fails, retaining the project
 * would show one workspace while new sessions may inherit another, so the prior
 * selection is restored and the failure is surfaced.
 */
export async function applyProjectWorkspaceActivation({
  project,
  expanded,
  dependencies,
}: ActivationRequest): Promise<ProjectWorkspaceActivationResult> {
  if (!expanded) {
    if (dependencies.getActiveProjectId() === project.id) {
      dependencies.setActiveProjectId(null);
      return 'deactivated';
    }
    return 'ignored';
  }

  if (project.isArchived) {
    return 'ignored';
  }

  const previousActiveProjectId = dependencies.getActiveProjectId();
  dependencies.setActiveProjectId(project.id);

  let reason: string;
  try {
    const result = await dependencies.setWorkingDirPath(project.workdir);
    if (result.success) {
      return 'activated';
    }
    reason = result.error?.trim() ? result.error : 'Workspace display update did not succeed';
  } catch (error: unknown) {
    reason = activationFailureReason(error);
  }

  dependencies.setActiveProjectId(previousActiveProjectId);
  dependencies.notify({
    id: `workspace-activation-${project.id}-${(dependencies.now ?? Date.now)()}`,
    type: 'error',
    message: '',
    messageKey: 'projects.errors.workspaceActivationFailed',
    messageValues: {
      project: project.name,
      reason,
    },
  });
  return 'reverted';
}
