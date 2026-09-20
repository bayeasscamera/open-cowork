import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  FileCode,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Pin,
  Plus,
  Search,
  Send,
  X,
} from 'lucide-react';
import { useAppStore } from '../../store';
import { useIPC } from '../../hooks/useIPC';
import type { ProjectContextUsage, Session } from '../../types';

/**
 * Dedicated full-width project pages (Claude Desktop style), replacing the
 * old browse-modal flow:
 *  - list view: card grid, one card per project;
 *  - detail view: two-column layout — conversation starter + session history
 *    on the left, instructions and reference-file context on the right.
 *
 * Data comes from the store (projects + sessions are already loaded) and the
 * existing projects.* IPC endpoints; the only addition is the context-injection
 * usage reported by projects.get.
 */

function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext);
}

function isCodePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return [
    'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h',
    'sh', 'json', 'yaml', 'yml', 'toml', 'sql', 'css', 'html',
  ].includes(ext);
}

function formatDate(timestamp: number, language: string): string {
  return new Intl.DateTimeFormat(language, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(timestamp));
}

export function ProjectsPages() {
  const projectsPage = useAppStore((s) => s.projectsPage);
  if (!projectsPage) return null;
  return projectsPage.view === 'list' ? (
    <ProjectsListView />
  ) : (
    <ProjectDetailView projectId={projectsPage.projectId} />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// View 1 — project list
// ─────────────────────────────────────────────────────────────────────────────

function ProjectsListView() {
  const { t, i18n } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const sessions = useAppStore((s) => s.sessions);
  const openProjectDetail = useAppStore((s) => s.openProjectDetail);
  const closeProjectsPage = useAppStore((s) => s.closeProjectsPage);
  const openProjectsModal = useAppStore((s) => s.openProjectsModal);

  const cards = useMemo(() => {
    return projects.map((project) => {
      const linked = sessions.filter((s) => s.projectId === project.id);
      const lastActivity =
        linked.reduce((max, s) => Math.max(max, s.updatedAt || s.createdAt), 0) ||
        project.updatedAt;
      const hasPinned = linked.some((s) => s.isPinned);
      return { project, lastActivity, hasPinned, sessionCount: linked.length };
    });
  }, [projects, sessions]);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-3 px-8 pt-6 pb-4 border-b border-border-muted">
        <button
          onClick={closeProjectsPage}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
          title={t('projects.backToList')}
          aria-label={t('projects.backToList')}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-xl font-semibold text-text-primary">
          {t('projects.sidebarSection')}
        </h1>
        <div className="flex-1" />
        <button
          onClick={() => openProjectsModal(null)}
          className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:bg-accent-hover transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{t('projects.newTitle')}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {cards.length === 0 ? (
          <div className="py-16 text-center">
            <FolderOpen className="w-10 h-10 mx-auto text-text-muted" />
            <p className="mt-3 text-sm text-text-secondary">{t('projects.emptyHint')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {cards.map(({ project, lastActivity, hasPinned, sessionCount }) => (
              <button
                key={project.id}
                onClick={() => openProjectDetail(project.id)}
                className={`text-left rounded-2xl border p-4 transition-colors hover:bg-surface-hover/60 ${
                  project.archived
                    ? 'border-border-muted opacity-60'
                    : 'border-border-muted bg-surface/60'
                }`}
              >
                <div className="flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-text-muted flex-shrink-0" />
                  <span className="text-[14px] font-semibold text-text-primary truncate flex-1">
                    {project.name}
                  </span>
                  {hasPinned && (
                    <span title={t('sidebar.pinned')} className="flex-shrink-0">
                      <Pin className="w-3 h-3 text-accent -rotate-45" />
                    </span>
                  )}
                  {project.archived && (
                    <span className="text-[10px] uppercase tracking-wider text-text-muted flex-shrink-0">
                      {t('projects.archivedTag')}
                    </span>
                  )}
                </div>
                {project.description && (
                  <p className="mt-2 text-[12px] leading-5 text-text-secondary line-clamp-2">
                    {project.description}
                  </p>
                )}
                <div className="mt-3 flex items-center justify-between text-[11px] text-text-muted">
                  <span>
                    {sessionCount > 0
                      ? t('projects.cardSessionCount', { count: sessionCount })
                      : t('projects.noSessionsInProject')}
                  </span>
                  <span>{formatDate(lastActivity, i18n.language)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// View 2 — project detail (two columns)
// ─────────────────────────────────────────────────────────────────────────────

function ProjectDetailView({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const sessions = useAppStore((s) => s.sessions);
  const closeProjectsPage = useAppStore((s) => s.closeProjectsPage);
  const openProjectsList = useAppStore((s) => s.openProjectsList);
  const { startSession, getSessionMessages, getSessionTraceSteps, isElectron } = useIPC();

  const project = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId]
  );

  const projectSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)),
    [sessions, projectId]
  );
  const pinnedSessions = projectSessions.filter((s) => s.isPinned);
  const recentSessions = projectSessions.filter((s) => !s.isPinned);

  const [prompt, setPrompt] = useState('');
  const [usage, setUsage] = useState<ProjectContextUsage | null>(null);
  const [instructionsDraft, setInstructionsDraft] = useState('');
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull the context-injection usage (and re-sync the project) from the backend.
  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI.projects.get(projectId);
      if (result.success && result.project) {
        const updated = result.project;
        const store = useAppStore.getState();
        store.setProjects(store.projects.map((p) => (p.id === updated.id ? updated : p)));
        setUsage(result.usage ?? null);
      }
    } catch {
      // Usage is decorative — never block the page on it.
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (project) setInstructionsDraft(project.instructions ?? '');
  }, [project]);

  const openSession = useCallback(
    async (sessionId: string) => {
      closeProjectsPage();
      useAppStore.getState().setActiveSession(sessionId);
      const states = useAppStore.getState().sessionStates;
      if (isElectron) {
        try {
          if (!states[sessionId]?.messages?.length) {
            const messages = await getSessionMessages(sessionId);
            if (messages && messages.length > 0) {
              useAppStore.getState().setMessages(sessionId, messages);
            }
          }
          if (!states[sessionId]?.traceSteps?.length) {
            const steps = await getSessionTraceSteps(sessionId);
            useAppStore.getState().setTraceSteps(sessionId, steps || []);
          }
        } catch (err) {
          console.error('[ProjectsPages] Failed to load session content:', err);
        }
      }
    },
    [closeProjectsPage, getSessionMessages, getSessionTraceSteps, isElectron]
  );

  if (!project) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center bg-background">
        <button
          onClick={openProjectsList}
          className="text-[13px] text-text-secondary hover:text-text-primary"
        >
          {t('projects.backToList')}
        </button>
      </div>
    );
  }

  const usedChars = usage ? usage.instructionsChars + usage.filesChars : 0;
  const maxChars = usage?.maxChars ?? 40000;
  const percent = Math.min(100, Math.round((usedChars / Math.max(1, maxChars)) * 100));

  const handleStartSession = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const sessionTitle = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
    const session = await startSession(
      sessionTitle,
      [{ type: 'text', text: trimmed }],
      project.workdir,
      project.id
    );
    setPrompt('');
    if (session) closeProjectsPage();
  };

  const saveInstructions = async () => {
    if (!editingInstructions) return;
    setSavingInstructions(true);
    setError(null);
    try {
      const result = await window.electronAPI.projects.update({
        projectId: project.id,
        instructions: instructionsDraft.trim() || null,
      });
      if (!result.success) {
        setError(result.error || t('projects.errors.saveFailed'));
        return;
      }
      if (result.project) {
        const updated = result.project;
        const store = useAppStore.getState();
        store.setProjects(store.projects.map((p) => (p.id === updated.id ? updated : p)));
      }
      setEditingInstructions(false);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.errors.saveFailed'));
    } finally {
      setSavingInstructions(false);
    }
  };

  const attachFiles = async () => {
    setAttaching(true);
    setError(null);
    try {
      const paths = await window.electronAPI.selectFiles();
      for (const filePath of paths) {
        const result = await window.electronAPI.projects.attachFile(project.id, filePath);
        if (!result.success) {
          setError(result.error || t('projects.errors.attachFailed'));
          return;
        }
      }
      await refresh();
    } catch {
      // dialog cancelled
    } finally {
      setAttaching(false);
    }
  };

  const detachFile = async (filePath: string) => {
    setError(null);
    try {
      const result = await window.electronAPI.projects.detachFile(project.id, filePath);
      if (!result.success) {
        setError(result.error || t('projects.errors.detachFailed'));
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.errors.detachFailed'));
    }
  };

  const visibleFiles = project.referenceFiles.filter((f) =>
    f.toLowerCase().includes(fileSearch.trim().toLowerCase())
  );

  const renderSessionRow = (session: Session) => (
    <button
      key={session.id}
      onClick={() => void openSession(session.id)}
      className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-surface-hover/60 transition-colors"
    >
      {session.isPinned && (
        <Pin className="w-3 h-3 text-accent flex-shrink-0 -rotate-45" />
      )}
      <span className="flex-1 min-w-0 truncate text-[13px] text-text-primary">
        {session.title}
      </span>
      <span className="flex-shrink-0 text-[11px] text-text-muted">
        {formatDate(session.updatedAt || session.createdAt, i18n.language)}
      </span>
    </button>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-background">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 px-8 pt-5 pb-3">
        <button
          onClick={closeProjectsPage}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
          title={t('projects.backToList')}
          aria-label={t('projects.backToList')}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button
          onClick={openProjectsList}
          className="text-[13px] text-text-secondary hover:text-text-primary transition-colors"
        >
          {t('projects.sidebarSection')}
        </button>
        <span className="text-[13px] text-text-muted">/</span>
        <span className="text-[13px] font-medium text-text-primary truncate">
          {project.name}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Main column */}
        <div className="flex-1 min-w-0 overflow-y-auto px-8 pb-8">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text-primary">
            {project.name}
          </h1>

          {/* Conversation starter — new session bound to this project */}
          <div className="mt-5 rounded-2xl border border-border-muted bg-surface/60 p-2.5">
            <div className="flex items-end gap-2">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleStartSession();
                  }
                }}
                rows={1}
                placeholder={t('projects.askPlaceholder')}
                className="flex-1 min-w-0 resize-none max-h-[40vh] overflow-y-auto bg-transparent border-none outline-none text-text-primary placeholder:text-text-muted text-[14px] py-1.5 px-2 leading-relaxed"
              />
              <button
                onClick={() => void handleStartSession()}
                disabled={!prompt.trim()}
                className="w-8 h-8 rounded-xl flex items-center justify-center bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-40"
                title={t('chat.sendMessage')}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Pinned sessions of this project */}
          {pinnedSessions.length > 0 && (
            <section className="mt-7">
              <h2 className="text-[13px] font-semibold text-text-primary mb-1.5">
                {t('sidebar.pinned')}
              </h2>
              <div className="space-y-0.5">{pinnedSessions.map(renderSessionRow)}</div>
            </section>
          )}

          {/* Recent sessions of this project */}
          <section className="mt-7">
            <h2 className="text-[13px] font-semibold text-text-primary mb-1.5">
              {t('projects.recent')}
            </h2>
            {recentSessions.length === 0 ? (
              <p className="text-[12px] text-text-muted">{t('projects.noSessionsInProject')}</p>
            ) : (
              <div className="space-y-0.5">{recentSessions.map(renderSessionRow)}</div>
            )}
          </section>
        </div>

        {/* Side column */}
        <aside className="w-[320px] flex-shrink-0 border-l border-border-muted overflow-y-auto p-6 space-y-6">
          {/* Instructions */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                {t('projects.instructions')}
              </h3>
              {!editingInstructions && (
                <button
                  onClick={() => {
                    setInstructionsDraft(project.instructions ?? '');
                    setEditingInstructions(true);
                  }}
                  className="w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                  title={t('projects.editInstructions')}
                >
                  <Pencil className="w-3 h-3" />
                </button>
              )}
            </div>
            {editingInstructions ? (
              <div>
                <textarea
                  value={instructionsDraft}
                  onChange={(e) => setInstructionsDraft(e.target.value)}
                  rows={8}
                  autoFocus
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-[12px] text-text-primary focus:outline-none focus:border-accent resize-y"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => {
                      setInstructionsDraft(project.instructions ?? '');
                      setEditingInstructions(false);
                    }}
                    className="flex-1 px-3 py-1.5 rounded-lg text-[12px] text-text-secondary hover:bg-surface-hover transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={() => void saveInstructions()}
                    disabled={savingInstructions}
                    className="flex-1 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-60"
                  >
                    {savingInstructions ? t('projects.saving') : t('projects.save')}
                  </button>
                </div>
              </div>
            ) : project.instructions ? (
              <p className="text-[12px] leading-5 text-text-secondary line-clamp-6">
                {project.instructions}
              </p>
            ) : (
              <p className="text-[12px] text-text-muted">{t('projects.noInstructions')}</p>
            )}
          </section>

          {/* Context (reference files) */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                {t('projects.context')}
              </h3>
              <button
                onClick={() => void attachFiles()}
                disabled={attaching}
                className="w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
                title={t('projects.attachFile')}
              >
                {attaching ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Plus className="w-3 h-3" />
                )}
              </button>
            </div>

            {/* Real injection-budget progress bar */}
            <div className="rounded-xl border border-border-muted bg-surface/60 p-3">
              <div className="h-1.5 rounded-full bg-background overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="mt-2 text-[11px] text-text-muted">
                {t('projects.capacityUsed', { percent })}
              </p>
              {usage && usage.filesTotal > usage.filesInjected && (
                <p className="mt-1 text-[11px] text-amber-500">
                  {t('projects.filesBeyondBudget', {
                    count: usage.filesTotal - usage.filesInjected,
                  })}
                </p>
              )}
            </div>

            {/* Thumbnails */}
            {project.referenceFiles.length > 0 && (
              <div className="mt-3">
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-text-muted" />
                  <input
                    type="text"
                    value={fileSearch}
                    onChange={(e) => setFileSearch(e.target.value)}
                    placeholder={t('projects.searchFiles')}
                    className="w-full rounded-lg border border-transparent bg-background/60 pl-7 pr-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-border"
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {visibleFiles.map((filePath) => {
                    const fileName = filePath.split('/').pop() || filePath;
                    const Icon = isImagePath(filePath)
                      ? ImageIcon
                      : isCodePath(filePath)
                        ? FileCode
                        : FileText;
                    return (
                      <div
                        key={filePath}
                        className="group relative rounded-xl border border-border-muted bg-surface/60 p-2 flex flex-col items-center gap-1"
                        title={filePath}
                      >
                        <button
                          onClick={() => void detachFile(filePath)}
                          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-error text-white items-center justify-center hidden group-hover:flex"
                          title={t('projects.removeFile')}
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                        <Icon className="w-5 h-5 text-text-secondary" />
                        <span className="w-full text-center text-[10px] text-text-secondary truncate">
                          {fileName}
                        </span>
                      </div>
                    );
                  })}
                  {visibleFiles.length === 0 && (
                    <p className="col-span-3 text-[11px] text-text-muted">
                      {t('projects.noReferenceFiles')}
                    </p>
                  )}
                </div>
              </div>
            )}
            {project.referenceFiles.length === 0 && (
              <p className="text-[12px] text-text-muted">{t('projects.noReferenceFiles')}</p>
            )}
          </section>

          {error && (
            <p className="text-[12px] text-red-400" role="alert">
              {error}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}