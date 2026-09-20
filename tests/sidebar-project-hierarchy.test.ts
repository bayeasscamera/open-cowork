import { describe, expect, it } from 'vitest';
import { partitionSidebarSessions } from '../src/renderer/utils/sidebar-partition';
import type { Session } from '../src/shared/types';

/**
 * Behavioral proofs for the three-level sidebar hierarchy:
 * 1. Projects — their linked sessions live ONLY under the project accordion.
 * 2. Pinned — pinned conversations that belong to no project.
 * 3. History — everything else, grouped by date by the sidebar.
 */

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: `sess-${Math.random().toString(36).slice(2)}`,
    title: 'Session',
    status: 'idle',
    cwd: '/tmp',
    mountedPaths: [],
    allowedTools: [],
    memoryEnabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const ABIO = 'project-abio';
const known = new Set([ABIO]);

describe('partitionSidebarSessions — three-level hierarchy', () => {
  it('a session linked to a project appears ONLY under that project (never in the general list)', () => {
    // The real reported case: "Plateforme Abio" linked to project ABIO was
    // still mixed into the dated history.
    const plateformeAbio = makeSession({
      title: 'Plateforme Abio',
      projectId: ABIO,
      isPinned: false,
    });
    const free = makeSession({ title: 'Une conversation libre' });

    const result = partitionSidebarSessions([plateformeAbio, free], known);

    expect(result.byProject.get(ABIO)).toEqual([plateformeAbio]);
    expect(result.history).not.toContain(plateformeAbio);
    expect(result.pinned).not.toContain(plateformeAbio);
    expect(result.history).toEqual([free]);
  });

  it('a pinned session OUTSIDE any project appears only in the pinned section', () => {
    const pinnedFree = makeSession({ title: 'Épinglée hors projet', isPinned: true });

    const result = partitionSidebarSessions([pinnedFree], known);

    expect(result.pinned).toEqual([pinnedFree]);
    expect(result.history).not.toContain(pinnedFree);
    expect(result.byProject.size).toBe(0);
  });

  it('a pinned session INSIDE a project stays under the project (project membership wins)', () => {
    const pinnedInProject = makeSession({ title: 'Épinglée dans ABIO', projectId: ABIO, isPinned: true });

    const result = partitionSidebarSessions([pinnedInProject], known);

    expect(result.byProject.get(ABIO)).toEqual([pinnedInProject]);
    expect(result.pinned).not.toContain(pinnedInProject);
    expect(result.history).not.toContain(pinnedInProject);
  });

  it('a session referencing an UNKNOWN project id falls back to the general sections', () => {
    // Deleted project or stale link: never hide a session silently.
    const orphaned = makeSession({ projectId: 'project-gone', isPinned: false });
    const orphanedPinned = makeSession({ projectId: 'project-gone', isPinned: true });

    const result = partitionSidebarSessions([orphaned, orphanedPinned], known);

    expect(result.history).toEqual([orphaned]);
    expect(result.pinned).toEqual([orphanedPinned]);
    expect(result.byProject.size).toBe(0);
  });

  it('a session appears in exactly ONE section (single place of truth)', () => {
    const sessions = [
      makeSession({ projectId: ABIO }),
      makeSession({ isPinned: true }),
      makeSession({}),
    ];

    const result = partitionSidebarSessions(sessions, known);

    const inProject = [...result.byProject.values()].flat();
    const total = inProject.length + result.pinned.length + result.history.length;
    expect(total).toBe(sessions.length);
    const ids = new Set([...inProject, ...result.pinned, ...result.history].map((s) => s.id));
    expect(ids.size).toBe(sessions.length);
  });

  it('sessions under a project are sorted by most recent activity first', () => {
    const older = makeSession({ projectId: ABIO, updatedAt: 1000, createdAt: 1000 });
    const newer = makeSession({ projectId: ABIO, updatedAt: 5000, createdAt: 1000 });

    const result = partitionSidebarSessions([older, newer], known);

    expect(result.byProject.get(ABIO)).toEqual([newer, older]);
  });
});