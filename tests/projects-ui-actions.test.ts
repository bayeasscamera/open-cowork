import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Source contracts for the Projects session-move/remove actions and the
 * permanent-delete flow — the behavior itself is proven on the real database
 * in tests/project-store.test.ts; these pin the UI wiring.
 */

const sidebar = readFileSync('src/renderer/components/Sidebar.tsx', 'utf8');
const panel = readFileSync('src/renderer/components/ProjectsPanel.tsx', 'utf8');

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
});

describe('ProjectsPanel permanent delete', () => {
  it('delete is only offered on archived projects, behind an explicit confirmation', () => {
    // The red zone renders only when archived, and asks twice.
    expect(panel).toContain('isEdit && archived && (');
    expect(panel).toContain('setConfirmDelete');
    expect(panel).toContain('projects.delete(projectsModalProjectId)');
    expect(panel).toContain("t('projects.deleteWarning')");
  });

  it('deleting clears a sidebar filter that pointed at the deleted project', () => {
    expect(panel).toContain(
      "useAppStore.getState().activeProjectId === projectsModalProjectId"
    );
    expect(panel).toContain('setActiveProjectId(null)');
  });
});
