import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Source contracts for the dedicated project pages (list + detail), replacing
 * the old modal-only browse flow. Behavioral proofs live in
 * tests/project-store.test.ts (CRUD/linking) and
 * tests/project-context-usage.test.ts (real injection budget).
 */

const pages = readFileSync('src/renderer/components/projects/ProjectsPages.tsx', 'utf8');
const pagesFlat = pages.replace(/\s+/g, ' ');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const sidebar = readFileSync('src/renderer/components/Sidebar.tsx', 'utf8');

describe('ProjectsPages — routing integration', () => {
  it('both views exist behind the store-driven projectsPage state', () => {
    expect(pages).toContain("projectsPage.view === 'list'");
    expect(pages).toContain('<ProjectDetailView projectId={projectsPage.projectId} />');
  });

  it('App renders the pages full-width and hides side panels while open', () => {
    expect(app).toContain('projectsPage ? (');
    expect(app).toContain('<ProjectsPages />');
    // Side panels stay hidden while the pages (or the dedicated Sub-agents
    // view) are open — both flags are part of the same gating condition.
    expect(app).toContain('!projectsPage && !subAgentsVisible && (');
  });
});

describe('ProjectsListView — card grid', () => {
  it('cards show name, pinned indicator, description and last-activity date', () => {
    expect(pages).toContain('line-clamp-2');
    expect(pages).toContain('formatDate(lastActivity, i18n.language)');
    expect(pages).toContain('hasPinned && (');
  });

  it('clicking a card opens the detail view; header opens the create modal', () => {
    expect(pages).toContain('openProjectDetail(project.id)');
    expect(pages).toContain('openProjectsModal(null)');
  });
});

describe('ProjectDetailView — two-column layout', () => {
  it('starts a new session bound to the project (project_id pre-filled)', () => {
    expect(pagesFlat).toContain(
      "const session = await startSession( sessionTitle, [{ type: 'text', text: trimmed }], project.workdir, project.id )"
    );
    expect(pages).toContain('closeProjectsPage()');
  });

  it('splits project sessions into Pinned and Recent sections with dates', () => {
    expect(pages).toContain('pinnedSessions.map(renderSessionRow)');
    expect(pages).toContain('recentSessions.map(renderSessionRow)');
    expect(pagesFlat).toContain(
      'formatDate(session.updatedAt || session.createdAt, i18n.language)'
    );
  });

  it('edits instructions INLINE and persists via projects.update', () => {
    expect(pages).toContain('setEditingInstructions');
    expect(pages).toContain(
      "instructions: instructionsDraft.trim() || null,"
    );
    expect(pages).toContain('projects.update({');
  });

  it('renders the REAL injection-budget progress bar (not an invented figure)', () => {
    expect(pages).toContain("t('projects.capacityUsed', { percent })");
    expect(pages).toContain('usage.instructionsChars + usage.filesChars');
    expect(pages).toContain("t('projects.filesBeyondBudget', {");
  });

  it('renders reference files as typed thumbnails with add, remove and search', () => {
    expect(pages).toContain('isImagePath(filePath)');
    expect(pages).toContain('isCodePath(filePath)');
    expect(pages).toContain('projects.attachFile(project.id, filePath)');
    expect(pages).toContain('projects.detachFile(project.id, filePath)');
    expect(pages).toContain("t('projects.searchFiles')");
  });

  it('navigates: breadcrumb back to the list, sessions open the conversation', () => {
    expect(pages).toContain('openProjectsList');
    expect(pages).toContain('setActiveSession(sessionId)');
  });

  it('adds an EXISTING unassigned conversation via linkSession (no prompt needed)', () => {
    // Genuine missing flow: previously only new sessions (with a prompt) or
    // sidebar moves could join a project. The detail view now lists sessions
    // with no projectId and links them through the existing linkSession IPC.
    expect(pages).toContain("t('projects.addExisting')");
    expect(pages).toContain('linkableSessions');
    expect(pages).toContain('!s.projectId');
    expect(pages).toContain('projects.linkSession(projectId, sessionId)');
    expect(pages).toContain('updateSession(sessionId, { projectId })');
  });
});

describe('Sidebar entry point', () => {
  it('the Projects section label opens the dedicated list page', () => {
    expect(sidebar).toContain('onClick={openProjectsList}');
  });
});