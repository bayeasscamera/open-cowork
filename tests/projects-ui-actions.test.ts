import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Source contracts for the Projects session-move/remove actions and the
 * permanent-delete flow — the behavior itself is proven on the real database
 * in tests/project-store.test.ts; these pin the UI wiring.
 */

const sidebar = readFileSync('src/renderer/components/Sidebar.tsx', 'utf8');
const panel = readFileSync('src/renderer/components/ProjectsPanel.tsx', 'utf8');
// Whitespace-insensitive view for assertions spanning reformatted lines.
const panelFlat = panel.replace(/\s+/g, ' ');

describe('Sidebar session project actions', () => {
  it('every session row offers a project action opening a picker popover', () => {
    expect(sidebar).toContain('projectPickerSessionId');
    expect(sidebar).toContain("t('projects.moveToProject')");
    expect(sidebar).toContain('projects.linkSession(projectId, sessionId)');
  });

  it('a linked session can be removed from its project via the same picker', () => {
    expect(sidebar).toContain("t('projects.removeFromProject')");
    expect(sidebar).toContain('projects.unlinkSession(sessionId)');
  });

  it('move/remove update the local session so the project filter reacts immediately', () => {
    expect(sidebar).toContain(
      "useAppStore.getState().updateSession(sessionId, { projectId })"
    );
    expect(sidebar).toContain(
      'useAppStore.getState().updateSession(sessionId, { projectId: undefined })'
    );
  });

  it('the picker closes on outside click (backdrop) and never buries the action', () => {
    // Hover action button, not a nested submenu.
    expect(sidebar).toContain('hoveredSession === session.id');
    expect(sidebar).toContain('setProjectPickerSessionId(null)');
  });

  it('the move picker never offers ARCHIVED projects as a destination', () => {
    expect(sidebar).toContain('.filter((project) => !project.archived)');
  });
});

describe('Sidebar archived projects stay reachable (delete/restore dead-end fix)', () => {
  it('loads the project list WITH archived projects', () => {
    expect(sidebar).toContain('projects.list(true)');
    expect(sidebar).not.toContain('projects.list(false)');
  });

  it('archived projects render distinctly and stay editable via the pencil action', () => {
    expect(sidebar).toContain("t('projects.archivedTag')");
    expect(sidebar).toContain('opacity-60');
    expect(sidebar).toContain('openProjectsModal(project.id)');
  });
});

describe('Sidebar three-level hierarchy and search removal', () => {
  it('partitions sessions with the shared utility (projects / pinned / history)', () => {
    expect(sidebar).toContain(
      "import { partitionSidebarSessions } from '../utils/sidebar-partition';"
    );
    expect(sidebar).toContain('partitionSidebarSessions(sessions, knownProjectIds)');
  });

  it('renders a dedicated pinned section between projects and the dated history', () => {
    expect(sidebar).toContain("t('sidebar.pinned')");
    expect(sidebar).toContain('pinnedSessions.map(renderSessionRow)');
    expect(sidebar).toContain('groupedSessions.map');
  });

  it('the search bar is fully removed (no state, no UI, no orphaned effect)', () => {
    expect(sidebar).not.toContain('searchQuery');
    expect(sidebar).not.toContain("t('sidebar.search')");
    expect(sidebar).not.toContain('SearchIcon');
  });
});

describe('ProjectsPanel permanent delete', () => {
  it('the delete zone is ALWAYS visible in the edit modal — no dead-end', () => {
    // Regression: the zone used to render only for archived projects, which
    // were simultaneously invisible in the sidebar — delete was unreachable.
    expect(panel).toContain('{isEdit && (');
    expect(panel).not.toContain('{isEdit && archived && (');
  });

  it('deleting a still-active project archives it first (backend guard intact)', () => {
    expect(panel).toContain('if (!archived) {');
    expect(panelFlat).toContain('projects.archive( projectsModalProjectId, true )');
    expect(panel).toContain('projects.delete(projectsModalProjectId)');
  });

  it('the warning text adapts: archived vs archive-first flows', () => {
    expect(panel).toContain("t('projects.deleteWarning')");
    expect(panel).toContain("t('projects.deleteWarningArchiveFirst')");
  });

  it('deleting clears a sidebar filter that pointed at the deleted project', () => {
    expect(panel).toContain(
      "useAppStore.getState().activeProjectId === projectsModalProjectId"
    );
    expect(panel).toContain('setActiveProjectId(null)');
  });
});
