import { useState, useCallback, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import {
  ChevronLeft,
  ChevronRight,
  Trash2,
  Moon,
  Sun,
  Monitor,
  Settings,
  Plus,
  ListChecks,
  Check,
  Pin,
  Pencil,
  FolderOpen,
  X,
} from 'lucide-react';
import type { Session } from '../types';
import { partitionSidebarSessions } from '../utils/sidebar-partition';

import sidebarLogoSrc from '../assets/logo.png';

type SessionGroup = {
  key: string;
  label: string;
  sessions: Session[];
};

export function Sidebar() {
  const { t } = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const settings = useAppStore((s) => s.settings);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setMessages = useAppStore((s) => s.setMessages);
  const setTraceSteps = useAppStore((s) => s.setTraceSteps);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const isConfigured = useAppStore((s) => s.isConfigured);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const projects = useAppStore((s) => s.projects);
  const setProjects = useAppStore((s) => s.setProjects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const setActiveProjectId = useAppStore((s) => s.setActiveProjectId);
  const openProjectsModal = useAppStore((s) => s.openProjectsModal);
  const {
    deleteSession,
    batchDeleteSessions,
    renameSession,
    togglePinSession,
    getSessionMessages,
    getSessionTraceSteps,
    isElectron,
  } = useIPC();
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitleValue, setEditTitleValue] = useState('');
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  /** Projects the user explicitly expanded; the project holding the active
   *  session is always treated as expanded too. */
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());
  /** Session whose project picker popover is open; null = closed. */
  const [projectPickerSessionId, setProjectPickerSessionId] = useState<string | null>(null);

  /** Move a session into a project (single membership: relink moves it). */
  const handleMoveSessionToProject = useCallback(
    async (projectId: string, sessionId: string) => {
      setProjectPickerSessionId(null);
      try {
        const result = await window.electronAPI.projects.linkSession(projectId, sessionId);
        if (result.success) {
          useAppStore.getState().updateSession(sessionId, { projectId });
        }
      } catch {
        // Non-fatal: the sidebar keeps its current state.
      }
    },
    []
  );

  /** Detach a session from its project — it becomes a free conversation again. */
  const handleRemoveSessionFromProject = useCallback(async (sessionId: string) => {
    setProjectPickerSessionId(null);
    try {
      const result = await window.electronAPI.projects.unlinkSession(sessionId);
      if (result.success) {
        useAppStore.getState().updateSession(sessionId, { projectId: undefined });
      }
    } catch {
      // Non-fatal: the sidebar keeps its current state.
    }
  }, []);

  // Load projects once on mount (Electron mode only). Archived projects stay
  // visible — otherwise the restore/delete actions become unreachable.
  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.electronAPI.projects.list(true);
        if (!cancelled && result.success) setProjects(result.projects);
      } catch {
        // Projects are optional — sidebar works fine without them.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isElectron, setProjects]);

  const knownProjectIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);

  // Sessions linked to a known project live ONLY under that project's
  // accordion; everything else lands in the pinned or history sections.
  const {
    byProject: sessionsByProject,
    pinned: pinnedSessions,
    history: historySessions,
  } = useMemo(
    () => partitionSidebarSessions(sessions, knownProjectIds),
    [sessions, knownProjectIds]
  );

  const groupedSessions = useMemo(
    () => groupSessionsByDate(historySessions, t),
    [historySessions, t]
  );

  const isProjectExpanded = useCallback(
    (projectId: string) => {
      if (expandedProjectIds.has(projectId)) return true;
      return (sessionsByProject.get(projectId) || []).some((s) => s.id === activeSessionId);
    },
    [expandedProjectIds, sessionsByProject, activeSessionId]
  );

  const toggleProjectExpanded = useCallback((projectId: string) => {
    setExpandedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  // Exit select mode when sidebar collapses
  useEffect(() => {
    if (sidebarCollapsed && isSelectMode) {
      setIsSelectMode(false);
      setSelectedIds(new Set());
      setShowDeleteConfirm(false);
    }
  }, [sidebarCollapsed, isSelectMode]);

  // Escape key exits select mode
  useEffect(() => {
    if (!isSelectMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSelectMode(false);
        setSelectedIds(new Set());
        setShowDeleteConfirm(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSelectMode]);

  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
    setShowDeleteConfirm(false);
  }, []);

  const toggleSelectSession = useCallback((sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  // Batch selection applies to sessions rendered in the general area
  // (pinned + history); project sessions stay reachable via their hover actions.
  const visibleSessionIds = useMemo(
    () => [...pinnedSessions, ...historySessions].map((s) => s.id),
    [pinnedSessions, historySessions]
  );

  const allVisibleSelected =
    visibleSessionIds.length > 0 && visibleSessionIds.every((id) => selectedIds.has(id));

  const toggleSelectAll = useCallback(() => {
    if (allVisibleSelected) {
      // Deselect all visible, keep others
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSessionIds) {
          next.delete(id);
        }
        return next;
      });
    } else {
      // Select all visible, keep existing selections
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSessionIds) {
          next.add(id);
        }
        return next;
      });
    }
  }, [allVisibleSelected, visibleSessionIds]);

  const handleBatchDelete = useCallback(() => {
    const visibleSet = new Set(visibleSessionIds);
    const ids = Array.from(selectedIds).filter((id) => visibleSet.has(id));
    if (ids.length === 0) return;
    batchDeleteSessions(ids);
    exitSelectMode();
  }, [selectedIds, visibleSessionIds, batchDeleteSessions, exitSelectMode]);

  const handleSessionClick = useCallback(
    async (sessionId: string) => {
      setShowSettings(false);

      if (activeSessionId === sessionId) return;

      setActiveSession(sessionId);

      // Read sessionStates at call-time from the store rather than closing over
      // the selector value. The selector returns a new object reference every
      // time any session's state changes (patchSession spreads the whole map),
      // so including it in deps would rebuild this callback on every streaming
      // tick and cause a React #185 "Maximum update depth exceeded" loop when
      // rapidly switching sessions on slow renderers (e.g. Windows).
      const currentSessionStates = useAppStore.getState().sessionStates;

      const existingMessages = currentSessionStates[sessionId]?.messages;
      if ((!existingMessages || existingMessages.length === 0) && isElectron) {
        try {
          const messages = await getSessionMessages(sessionId);
          if (messages && messages.length > 0) {
            setMessages(sessionId, messages);
          }
        } catch (error) {
          console.error('[Sidebar] Failed to load messages:', error);
        }
      }

      const existingSteps = currentSessionStates[sessionId]?.traceSteps;
      if ((!existingSteps || existingSteps.length === 0) && isElectron) {
        try {
          const steps = await getSessionTraceSteps(sessionId);
          setTraceSteps(sessionId, steps || []);
        } catch (error) {
          console.error('[Sidebar] Failed to load trace steps:', error);
        }
      }
    },
    [
      activeSessionId,
      getSessionMessages,
      getSessionTraceSteps,
      isElectron,
      setActiveSession,
      setMessages,
      setShowSettings,
      setTraceSteps,
    ]
  );

  const handleNewSession = () => {
    setActiveSession(null);
    setShowSettings(false);
  };

  const handleDeleteSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    deleteSession(sessionId);
  };

  const handleStartRename = (e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    setEditingSessionId(session.id);
    setEditTitleValue(session.title);
  };

  const handleSaveRename = (sessionId: string) => {
    const trimmed = editTitleValue.trim();
    if (trimmed) {
      renameSession(sessionId, trimmed);
    }
    setEditingSessionId(null);
  };

  const handleCancelRename = () => {
    setEditingSessionId(null);
  };

  const handleTogglePin = (e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    togglePinSession(session.id, !session.isPinned);
  };

  const toggleTheme = () => {
    const next =
      settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'system' : 'dark';
    updateSettings({ theme: next });
  };

  const themeIcon =
    settings.theme === 'dark' ? (
      <Sun className="w-4 h-4" />
    ) : settings.theme === 'light' ? (
      <Moon className="w-4 h-4" />
    ) : (
      <Monitor className="w-4 h-4" />
    );

  // One row renderer used by all three levels: under a project accordion, in
  // the pinned section and in the dated history. Sessions inside a project are
  // not batch-selectable — their hover actions stay available instead.
  const renderSessionRow = (session: Session) => {
    const isActive = activeSessionId === session.id;
    const isSelected = selectedIds.has(session.id);
    const isEditing = editingSessionId === session.id;
    const selectable = isSelectMode && !session.projectId;

    return (
      <div
        key={session.id}
        onClick={() => {
          if (isEditing) return;
          if (selectable) {
            toggleSelectSession(session.id);
          } else {
            handleSessionClick(session.id);
          }
        }}
        onMouseEnter={() => setHoveredSession(session.id)}
        onMouseLeave={() => setHoveredSession(null)}
        className={`group relative cursor-pointer rounded-lg px-2.5 py-1.5 transition-colors ${
          selectable && isSelected
            ? 'bg-accent-muted/20'
            : isActive && !isSelectMode
              ? 'bg-surface-hover/80'
              : 'hover:bg-surface-hover/60'
        }`}
      >
        <div className={`flex items-center gap-2 ${!isSelectMode && !isEditing ? 'pr-16' : ''}`}>
          {selectable && (
            <div
              className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
                isSelected
                  ? 'bg-accent text-white'
                  : 'border border-border-muted bg-background'
              }`}
            >
              {isSelected && <Check className="w-2.5 h-2.5" />}
            </div>
          )}

          {session.isPinned && !isSelectMode && !isEditing && (
            <Pin className="w-3 h-3 text-accent flex-shrink-0 -rotate-45" />
          )}

          <div className="min-w-0 flex-1">
            {isEditing ? (
              <input
                type="text"
                autoFocus
                value={editTitleValue}
                onChange={(e) => setEditTitleValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveRename(session.id);
                  } else if (e.key === 'Escape') {
                    handleCancelRename();
                  }
                }}
                onBlur={() => handleSaveRename(session.id)}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-background border border-accent rounded px-1.5 py-0.5 text-[13px] font-medium text-text-primary focus:outline-none"
                placeholder={t('sidebar.renamePlaceholder')}
              />
            ) : (
              <div
                onDoubleClick={(e) => {
                  if (!isSelectMode) handleStartRename(e, session);
                }}
                className="text-[13px] font-medium leading-5 text-text-primary truncate"
                title={session.title}
              >
                {session.title}
              </div>
            )}
          </div>
        </div>

        {!isSelectMode && !isEditing && hoveredSession === session.id && (
          <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
            {projects.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setProjectPickerSessionId(
                    projectPickerSessionId === session.id ? null : session.id
                  );
                }}
                className={`w-6 h-6 rounded-lg flex items-center justify-center transition-colors ${
                  session.projectId
                    ? 'text-accent hover:bg-surface-active'
                    : 'text-text-muted hover:text-text-primary hover:bg-surface-active'
                }`}
                title={
                  session.projectId
                    ? t('projects.moveOrRemoveTitle')
                    : t('projects.moveToProject')
                }
              >
                <FolderOpen className="w-3 h-3" />
              </button>
            )}
            <button
              onClick={(e) => handleTogglePin(e, session)}
              className={`w-6 h-6 rounded-lg flex items-center justify-center transition-colors ${
                session.isPinned
                  ? 'text-accent hover:bg-surface-active'
                  : 'text-text-muted hover:text-text-primary hover:bg-surface-active'
              }`}
              title={session.isPinned ? t('sidebar.unpin') : t('sidebar.pin')}
            >
              <Pin className={`w-3 h-3 ${session.isPinned ? '-rotate-45' : ''}`} />
            </button>
            <button
              onClick={(e) => handleStartRename(e, session)}
              className="w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-active transition-colors"
              title={t('sidebar.rename')}
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              onClick={(e) => handleDeleteSession(e, session.id)}
              className="w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-error hover:bg-surface-active transition-colors"
              title={t('common.delete')}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Project picker popover: move to a project / remove from project */}
        {projectPickerSessionId === session.id && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={(e) => {
                e.stopPropagation();
                setProjectPickerSessionId(null);
              }}
            />
            <div
              className="absolute right-1.5 bottom-full z-50 mb-1 w-56 rounded-xl bg-surface border border-border shadow-elevated p-1.5 animate-in fade-in zoom-in-95"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {t('projects.moveToProject')}
              </div>
              {projects
                .filter((project) => !project.archived)
                .map((project) => (
                  <button
                    key={project.id}
                    onClick={() => void handleMoveSessionToProject(project.id, session.id)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[12px] transition-colors ${
                      session.projectId === project.id
                        ? 'bg-surface-hover text-accent'
                        : 'text-text-primary hover:bg-surface-hover'
                    }`}
                  >
                    <FolderOpen className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">{project.name}</span>
                  </button>
                ))}
              {session.projectId && (
                <>
                  <div className="my-1 border-t border-border-subtle" />
                  <button
                    onClick={() => void handleRemoveSessionFromProject(session.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[12px] text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                  >
                    <X className="w-3 h-3 flex-shrink-0" />
                    <span>{t('projects.removeFromProject')}</span>
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  if (sidebarCollapsed) {
    return (
      <aside className="w-[4.5rem] bg-surface/96 border-r border-border-muted flex flex-col overflow-hidden">
        <div className="px-3 pt-4 pb-3 flex flex-col items-center gap-2 border-b border-border-muted">
          <button
            onClick={toggleSidebar}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
            title={t('context.expandPanel')}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={handleNewSession}
            className="w-9 h-9 rounded-2xl flex items-center justify-center bg-background hover:bg-surface-hover transition-colors text-text-primary border border-border-subtle"
            title={t('sidebar.newTask')}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-3 py-4">
          <button
            onClick={toggleSidebar}
            className="rounded-2xl px-2 py-3 text-[11px] leading-4 text-center text-text-muted hover:bg-surface-hover transition-colors"
            title={t('sidebar.expandToView')}
          >
            {t('sidebar.expandToView')}
          </button>
        </div>

        <div className="px-3 py-3 border-t border-border-muted flex flex-col items-center gap-2">
          <button
            onClick={toggleTheme}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
            title={t('sidebar.themeToggle')}
          >
            {themeIcon}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary relative"
            title={t('sidebar.settings')}
          >
            <Settings className="w-4 h-4" />
            {!isConfigured && (
              <span className="absolute right-2 top-2 w-1.5 h-1.5 rounded-full bg-accent" />
            )}
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-[17.5rem] bg-surface/96 border-r border-border-muted flex flex-col overflow-hidden">
      <div className="px-4 pt-5 pb-4 border-b border-border-muted">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <img
              src={sidebarLogoSrc}
              alt={t('common.appLogoAlt')}
              className="w-10 h-10 rounded-2xl object-cover border border-border-subtle bg-background/60 flex-shrink-0"
            />
            <div className="min-w-0">
              <h1 className="text-[1.34rem] leading-none font-semibold tracking-[-0.035em] text-text-primary">
                Open Cowork
              </h1>
            </div>
          </div>
          <button
            onClick={toggleSidebar}
            className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary flex-shrink-0"
            title={t('context.collapsePanel')}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>

        <button
          onClick={handleNewSession}
          className="mt-3 w-full flex items-center gap-2 rounded-xl bg-background/60 px-3 py-2 text-left text-text-primary hover:bg-surface-hover transition-colors"
        >
          <Plus className="w-4 h-4 text-text-secondary flex-shrink-0" />
          <span className="text-[13px] font-medium">{t('sidebar.newTask')}</span>
        </button>

        {sessions.length > 0 && (
          <div className="mt-2 flex justify-end">
            <button
              onClick={() => {
                if (isSelectMode) {
                  exitSelectMode();
                } else {
                  setIsSelectMode(true);
                }
              }}
              className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${
                isSelectMode
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
              title={t('sidebar.manage')}
            >
              <ListChecks className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        {sessions.length === 0 ? (
          <div className="px-3 py-6">
            <p className="text-sm text-text-secondary">{t('sidebar.noTasks')}</p>
            <p className="mt-1 text-xs leading-5 text-text-muted">{t('sidebar.noTasksHint')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Level 1 — Projects: accordion holding ONLY their linked sessions */}
            <section>
              <div className="flex items-center justify-between px-3 pb-2">
                <span className="text-[11px] font-medium tracking-[0.04em] text-text-muted">
                  {t('projects.sidebarSection')}
                </span>
                <button
                  onClick={() => openProjectsModal(null)}
                  className="w-5 h-5 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                  title={t('projects.newTitle')}
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-0.5">
                {projects.map((project) => {
                  const projectSessionList = sessionsByProject.get(project.id) || [];
                  const isExpanded = isProjectExpanded(project.id);
                  const isActiveProject = activeProjectId === project.id;
                  const isArchived = project.archived;
                  return (
                    <div key={project.id}>
                      <div
                        onClick={() => {
                          const willExpand = !isExpanded;
                          toggleProjectExpanded(project.id);
                          if (!isArchived) {
                            if (willExpand) {
                              setActiveProjectId(project.id);
                            } else if (isActiveProject) {
                              setActiveProjectId(null);
                            }
                          }
                        }}
                        onMouseEnter={() => setHoveredProject(project.id)}
                        onMouseLeave={() => setHoveredProject(null)}
                        className={`group relative cursor-pointer flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition-colors ${
                          isArchived
                            ? 'opacity-60 hover:bg-surface-hover/40'
                            : isActiveProject
                              ? 'bg-surface-hover/80'
                              : 'hover:bg-surface-hover/60'
                        }`}
                      >
                        <ChevronRight
                          className={`w-3 h-3 text-text-muted flex-shrink-0 transition-transform ${
                            isExpanded ? 'rotate-90' : ''
                          }`}
                        />
                        <FolderOpen
                          className={`w-3.5 h-3.5 flex-shrink-0 ${
                            isArchived
                              ? 'text-text-muted'
                              : isActiveProject
                                ? 'text-accent'
                                : 'text-text-muted'
                          }`}
                        />
                        <span
                          className={`text-[12px] font-medium truncate ${
                            isActiveProject && !isArchived
                              ? 'text-text-primary'
                              : isArchived
                                ? 'text-text-muted'
                                : 'text-text-secondary'
                          }`}
                          title={
                            isArchived
                              ? `${project.name} (${t('projects.archivedTag')})`
                              : project.workdir
                          }
                        >
                          {project.name}
                        </span>
                        <span className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                          {projectSessionList.length > 0 && (
                            <span className="text-[10px] text-text-muted">
                              {projectSessionList.length}
                            </span>
                          )}
                          {isArchived && (
                            <span className="text-[10px] uppercase tracking-wider text-text-muted">
                              {t('projects.archivedTag')}
                            </span>
                          )}
                        </span>
                        {hoveredProject === project.id && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openProjectsModal(project.id);
                            }}
                            className="absolute right-1.5 w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-active transition-colors"
                            title={t('projects.editTitle')}
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      {isExpanded && projectSessionList.length > 0 && (
                        <div className="ml-[1.15rem] border-l border-border-subtle pl-2 py-0.5 space-y-0.5">
                          {projectSessionList.map(renderSessionRow)}
                        </div>
                      )}
                    </div>
                  );
                })}
                {projects.length === 0 && (
                  <p className="px-2.5 py-1 text-[11px] text-text-muted">
                    {t('projects.emptyHint')}
                  </p>
                )}
              </div>
            </section>

            {/* Level 2 — Pinned conversations that belong to no project */}
            {pinnedSessions.length > 0 && (
              <section>
                <div className="px-3 pb-2 text-[11px] font-medium tracking-[0.04em] text-text-muted">
                  {t('sidebar.pinned')}
                </div>
                <div className="space-y-0.5">{pinnedSessions.map(renderSessionRow)}</div>
              </section>
            )}

            {/* Level 3 — Everything else, grouped by date */}
            {groupedSessions.map((group) => (
              <section key={group.key}>
                <div className="px-3 pb-2 text-[11px] font-medium tracking-[0.04em] text-text-muted">
                  {group.label}
                </div>
                <div className="space-y-0.5">{group.sessions.map(renderSessionRow)}</div>
              </section>
            ))}
          </div>
        )}
      </div>

      {isSelectMode ? (
        <div className="px-3 py-3 border-t border-border-muted">
          {showDeleteConfirm ? (
            <div className="border border-error/30 bg-error/10 rounded-lg px-3 py-3">
              <p className="text-[13px] text-text-primary mb-3">
                {t('sidebar.batchDeleteConfirm', { count: selectedIds.size })}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 px-3 py-1.5 rounded-lg text-[13px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  {t('sidebar.cancel')}
                </button>
                <button
                  onClick={handleBatchDelete}
                  className="flex-1 px-3 py-1.5 rounded-lg text-[13px] font-medium bg-error text-white hover:bg-error/90 transition-colors"
                >
                  {t('sidebar.confirmDelete')}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <button
                  onClick={toggleSelectAll}
                  className="text-[12px] font-medium text-accent hover:text-accent/80 transition-colors"
                >
                  {allVisibleSelected ? t('sidebar.deselectAll') : t('sidebar.selectAll')}
                </button>
                <span className="text-[12px] text-text-muted">
                  {t('sidebar.nSelected', { count: selectedIds.size })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={exitSelectMode}
                  className="flex-1 px-3 py-2 rounded-xl text-[13px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  {t('sidebar.cancel')}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={selectedIds.size === 0}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium bg-error text-white hover:bg-error/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('common.delete')}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="px-3 py-3 border-t border-border-muted">
          <div className="flex items-center gap-2 rounded-2xl bg-background/50 px-3 py-2.5">
            <button
              onClick={() => setShowSettings(true)}
              className="flex-1 min-w-0 flex items-center gap-2 text-left text-text-secondary hover:text-text-primary transition-colors"
            >
              <Settings className="w-4 h-4 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-text-primary">
                  {t('sidebar.settings')}
                </div>
                <div className="text-[11px] text-text-muted truncate">
                  {isConfigured ? t('sidebar.apiConfigured') : t('sidebar.apiNotConfigured')}
                </div>
              </div>
            </button>

            <button
              onClick={toggleTheme}
              className="w-8 h-8 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
              title={t('sidebar.themeToggle')}
            >
              {themeIcon}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function groupSessionsByDate(sessions: Session[], t: (key: string) => string): SessionGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfPreviousWeek = startOfToday - 7 * 86_400_000;

  const buckets: SessionGroup[] = [
    { key: 'today', label: t('sidebar.today'), sessions: [] },
    { key: 'yesterday', label: t('sidebar.yesterday'), sessions: [] },
    { key: 'previousWeek', label: t('sidebar.previousWeek'), sessions: [] },
    { key: 'older', label: t('sidebar.older'), sessions: [] },
  ];

  const sortedSessions = [...sessions].sort(
    (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
  );
  for (const session of sortedSessions) {
    const timestamp = session.updatedAt || session.createdAt;
    if (timestamp >= startOfToday) {
      buckets[0].sessions.push(session);
    } else if (timestamp >= startOfYesterday) {
      buckets[1].sessions.push(session);
    } else if (timestamp >= startOfPreviousWeek) {
      buckets[2].sessions.push(session);
    } else {
      buckets[3].sessions.push(session);
    }
  }

  return buckets.filter((b) => b.sessions.length > 0);
}