import type { Session } from '../types';

/**
 * Partition the session list for the three-level sidebar hierarchy.
 *
 * A session linked to a KNOWN project lives only under that project's
 * accordion (never in the general list). A session with no project — or linked
 * to a project id that is not in the loaded list — goes to the pinned section
 * when pinned, otherwise to the dated history.
 */
export function partitionSidebarSessions(
  sessions: Session[],
  knownProjectIds: ReadonlySet<string>
): {
  byProject: Map<string, Session[]>;
  pinned: Session[];
  history: Session[];
} {
  const byProject = new Map<string, Session[]>();
  const pinned: Session[] = [];
  const history: Session[] = [];

  for (const session of sessions) {
    const inKnownProject = Boolean(
      session.projectId && knownProjectIds.has(session.projectId)
    );
    if (inKnownProject) {
      const projectId = session.projectId as string;
      const list = byProject.get(projectId) || [];
      list.push(session);
      byProject.set(projectId, list);
    } else if (session.isPinned) {
      pinned.push(session);
    } else {
      history.push(session);
    }
  }

  for (const list of byProject.values()) {
    list.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }

  return { byProject, pinned, history };
}