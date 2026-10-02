import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  FileCode,
  FileText,
  Files,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  Pencil,
  Pin,
  Plus,
  Search,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { useAppStore } from '../../store';
import { useIPC } from '../../hooks/useIPC';
import { copyTextToClipboard } from '../../utils/clipboard';
import type { Project, ProjectContextUsage, Session } from '../../types';

/**
 * Dedicated full-width project pages (Claude Desktop style), replacing the
 * old browse-modal flow:
 *  - list view: card grid + dense list, with search, archive filter, sort,
 *    inline quick actions and a deterministic colour identity per project;
 *  - detail view: two-column layout — conversation starter + session history
 *    on the left, instructions and reference-file context (with a real
 *    injection-budget ring) on the right.
 *
 * Data comes from the store (projects + sessions are already loaded) and the
 * existing projects.* IPC endpoints; the only addition is the context-injection
 * usage reported by projects.get.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Small presentational helpers
// ─────────────────────────────────────────────────────────────────────────────

type ProjectSort = 'recent' | 'name' | 'created' | 'sessions';
type ProjectFilter = 'active' | 'archived' | 'all';
type ProjectView = 'grid' | 'list';
type FileKind = 'image' | 'code' | 'doc';

const PROJECT_FILTERS: ProjectFilter[] = ['active', 'archived', 'all'];
const PROJECT_VIEWS: ProjectView[] = ['grid', 'list'];

const FILTER_LABEL: Record<ProjectFilter, string> = {
  active: 'projects.filterActive',
  archived: 'projects.filterArchived',
  all: 'projects.filterAll',
};

const SORT_LABEL: Record<ProjectSort, string> = {
  recent: 'projects.sortRecent',
  name: 'projects.sortName',
  created: 'projects.sortCreated',
  sessions: 'projects.sortSessions',
};

const STATUS_LABEL: Record<Session['status'], string> = {
  idle: 'projects.statusIdle',
  running: 'projects.statusRunning',
  completed: 'projects.statusCompleted',
  error: 'projects.statusError',
};

const STATUS_TONE: Record<Session['status'], string> = {
  idle: 'bg-text-muted',
  running: 'bg-accent animate-pulse',
  completed: 'bg-success',
  error: 'bg-error',
};

/** Curated warm tones so every project keeps a stable visual identity. */
const AVATAR_TONES = [
  { bg: 'rgba(214, 122, 82, 0.16)', fg: '#d67a52' },
  { bg: 'rgba(157, 138, 188, 0.18)', fg: '#9d8abc' },
  { bg: 'rgba(106, 166, 201, 0.16)', fg: '#6aa6c9' },
  { bg: 'rgba(127, 176, 127, 0.16)', fg: '#7fb07f' },
  { bg: 'rgba(201, 167, 87, 0.16)', fg: '#c9a757' },
  { bg: 'rgba(196, 121, 143, 0.16)', fg: '#c4798f' },
];

function avatarTone(id: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

function projectInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '#';
}

function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext);
}

function isCodePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return [
    'ts',
    'tsx',
    'js',
    'jsx',
    'py',
    'rs',
    'go',
    'java',
    'c',
    'cpp',
    'h',
    'sh',
    'json',
    'yaml',
    'yml',
    'toml',
    'sql',
    'css',
    'html',
  ].includes(ext);
}

function fileKind(path: string): FileKind {
  if (isImagePath(path)) return 'image';
  if (isCodePath(path)) return 'code';
  return 'doc';
}

function formatDate(timestamp: number, language: string): string {
  return new Intl.DateTimeFormat(language, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(timestamp));
}

/** Compact "2 days ago" label; falls back to an absolute date when far away. */
function formatRelativeTime(timestamp: number, language: string, now = Date.now()): string {
  const diff = timestamp - now;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  try {
    const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
    if (abs < minute) return formatter.format(Math.round(diff / 1000), 'second');
    if (abs < hour) return formatter.format(Math.round(diff / minute), 'minute');
    if (abs < day) return formatter.format(Math.round(diff / hour), 'hour');
    if (abs < 30 * day) return formatter.format(Math.round(diff / day), 'day');
    if (abs < 365 * day) return formatter.format(Math.round(diff / (30 * day)), 'month');
    return formatter.format(Math.round(diff / (365 * day)), 'year');
  } catch {
    return formatDate(timestamp, language);
  }
}

function formatNumber(value: number, language: string): string {
  return value.toLocaleString(language);
}

/** Last path segment, for a compact workspace chip on the cards. */
function folderName(workdir: string): string {
  const parts = workdir.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || workdir;
}

function FileKindIcon({ kind, className }: { kind: FileKind; className?: string }) {
  if (kind === 'image') return <ImageIcon className={className} />;
  if (kind === 'code') return <FileCode className={className} />;
  return <FileText className={className} />;
}

function ProjectAvatar({ project, size = 'md' }: { project: Project; size?: 'md' | 'lg' }) {
  const tone = avatarTone(project.id);
  const dims =
    size === 'lg' ? 'h-12 w-12 rounded-2xl text-[18px]' : 'h-9 w-9 rounded-xl text-[14px]';
  return (
    <span
      aria-hidden="true"
      className={`flex flex-shrink-0 items-center justify-center font-semibold ${dims}`}
      style={{ backgroundColor: tone.bg, color: tone.fg }}
    >
      {projectInitial(project.name)}
    </span>
  );
}

function IconAction({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface/90 text-text-secondary backdrop-blur transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50 ${
        danger ? 'hover:text-error' : ''
      }`}
    >
      {children}
    </button>
  );
}

/** Real injection-budget ring — driven by the backend usage, never invented. */
function CapacityRing({ percent }: { percent: number }) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, percent));
  const offset = circumference * (1 - clamped / 100);
  const stroke =
    clamped >= 90
      ? 'var(--color-error)'
      : clamped >= 70
        ? 'var(--color-warning)'
        : 'var(--color-accent)';
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden="true">
      <circle cx="32" cy="32" r={radius} fill="none" stroke="var(--color-border)" strokeWidth="6" />
      <circle
        cx="32"
        cy="32"
        r={radius}
        fill="none"
        stroke={stroke}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="transition-all duration-500"
      />
    </svg>
  );
}

function SectionHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-muted">
        {title}
      </h3>
      {action}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

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
  const setProjects = useAppStore((s) => s.setProjects);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [filter, setFilter] = useState<ProjectFilter>('active');
  const [view, setView] = useState<ProjectView>('grid');
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);

  const archivedCount = useMemo(() => projects.filter((p) => p.archived).length, [projects]);
  const activeCount = projects.length - archivedCount;

  const overview = useMemo(() => {
    const knownProjectIds = new Set(projects.map((p) => p.id));
    return {
      conversations: sessions.filter((s) => s.projectId && knownProjectIds.has(s.projectId)).length,
      files: projects.reduce((total, p) => total + p.referenceFiles.length, 0),
    };
  }, [projects, sessions]);

  const cards = useMemo(() => {
    const decorated = projects.map((project) => {
      const linked = sessions.filter((s) => s.projectId === project.id);
      const lastActivity =
        linked.reduce((max, s) => Math.max(max, s.updatedAt || s.createdAt), 0) ||
        project.updatedAt;
      const hasPinned = linked.some((s) => s.isPinned);
      return {
        project,
        lastActivity,
        hasPinned,
        sessionCount: linked.length,
        fileCount: project.referenceFiles.length,
      };
    });

    const needle = query.trim().toLowerCase();
    const filtered = decorated.filter(({ project }) => {
      if (filter === 'active' && project.archived) return false;
      if (filter === 'archived' && !project.archived) return false;
      if (!needle) return true;
      return (
        project.name.toLowerCase().includes(needle) ||
        (project.description ?? '').toLowerCase().includes(needle) ||
        project.workdir.toLowerCase().includes(needle)
      );
    });

    // A copy: the store array must never be sorted in place.
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.project.name.localeCompare(b.project.name, i18n.language);
      if (sort === 'created') return b.project.createdAt - a.project.createdAt;
      if (sort === 'sessions') {
        return b.sessionCount - a.sessionCount || b.lastActivity - a.lastActivity;
      }
      return b.lastActivity - a.lastActivity;
    });
  }, [projects, sessions, query, sort, filter, i18n.language]);

  const filterCount = (id: ProjectFilter): number =>
    id === 'active' ? activeCount : id === 'archived' ? archivedCount : projects.length;

  const refreshProjects = useCallback(async () => {
    try {
      const result = await window.electronAPI.projects.list(true);
      if (result.success) setProjects(result.projects);
    } catch {
      // Non-fatal: the sidebar keeps its current list.
    }
  }, [setProjects]);

  const toggleArchive = useCallback(
    async (project: Project) => {
      setBusyProjectId(project.id);
      try {
        const result = await window.electronAPI.projects.archive(project.id, !project.archived);
        if (result.success) await refreshProjects();
      } catch {
        // Non-fatal — the card keeps its previous state.
      } finally {
        setBusyProjectId(null);
      }
    },
    [refreshProjects]
  );

  const renderActions = (project: Project, onEdit: () => void) => (
    <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <IconAction
        label={t('projects.openProject')}
        onClick={(e) => {
          e.stopPropagation();
          openProjectDetail(project.id);
        }}
      >
        <ArrowUpRight className="h-3.5 w-3.5" />
      </IconAction>
      <IconAction
        label={t('projects.quickEdit')}
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
      >
        <Pencil className="h-3.5 w-3.5" />
      </IconAction>
      <IconAction
        label={project.archived ? t('projects.restore') : t('projects.archive')}
        disabled={busyProjectId === project.id}
        onClick={(e) => {
          e.stopPropagation();
          void toggleArchive(project);
        }}
      >
        {busyProjectId === project.id ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : project.archived ? (
          <ArchiveRestore className="h-3.5 w-3.5" />
        ) : (
          <Archive className="h-3.5 w-3.5" />
        )}
      </IconAction>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="panel-glass flex-shrink-0 border-b border-border-muted px-8 pb-5 pt-6">
        <div className="flex items-center gap-3">
          <button
            onClick={closeProjectsPage}
            className="flex h-8 w-8 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            title={t('projects.backToList')}
            aria-label={t('projects.backToList')}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <p className="group-eyebrow">{t('projects.sidebarSection')}</p>
            <h1 className="mt-1 text-[1.35rem] font-semibold tracking-[-0.03em] text-text-primary">
              {t('projects.pageTitle')}
            </h1>
            <div className="accent-underline mt-1.5 w-12" />
          </div>
          <div className="flex-1" />
          <button
            onClick={() => openProjectsModal(null)}
            className="btn btn-primary px-3.5 py-2 text-[13px] shadow-premium"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{t('projects.newTitle')}</span>
          </button>
        </div>

        <p className="mt-3 max-w-2xl text-[12.5px] leading-5 text-text-secondary">
          {t('projects.pageSubtitle')}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-2.5 py-1">
            <FolderOpen className="h-3 w-3" />
            {t('projects.filterActive')} · <span className="tabular-nums">{activeCount}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-2.5 py-1">
            <Archive className="h-3 w-3" />
            {t('projects.filterArchived')} · <span className="tabular-nums">{archivedCount}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-2.5 py-1">
            <Sparkles className="h-3 w-3" />
            <span className="tabular-nums">{overview.conversations}</span>{' '}
            {t('projects.overviewSessions')}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-2.5 py-1">
            <Files className="h-3 w-3" />
            <span className="tabular-nums">{overview.files}</span> {t('projects.overviewFiles')}
          </span>
        </div>

        {/* Toolbar: search, archive filter, sort and layout — the list stays
            usable once a workspace holds dozens of projects. */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('projects.searchPlaceholder')}
              aria-label={t('projects.searchPlaceholder')}
              className="input py-2 pl-9 pr-8 text-[13px]"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
                title={t('projects.clearSearch')}
                aria-label={t('projects.clearSearch')}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <div
            role="group"
            aria-label={t('projects.filterLabel')}
            className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1"
          >
            {PROJECT_FILTERS.map((id) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                aria-pressed={filter === id}
                className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                  filter === id
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                }`}
              >
                {t(FILTER_LABEL[id])}
                <span className="ml-1.5 text-[11px] text-text-muted">{filterCount(id)}</span>
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 rounded-xl border border-border bg-surface px-2.5 py-1.5">
            <span className="text-[11px] text-text-muted">{t('projects.sortLabel')}</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as ProjectSort)}
              className="bg-transparent text-[12px] font-medium text-text-primary focus:outline-none"
            >
              {(['recent', 'name', 'created', 'sessions'] as ProjectSort[]).map((id) => (
                <option key={id} value={id}>
                  {t(SORT_LABEL[id])}
                </option>
              ))}
            </select>
          </label>

          <div
            role="group"
            aria-label={t('projects.viewList')}
            className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1"
          >
            {PROJECT_VIEWS.map((id) => (
              <button
                key={id}
                onClick={() => setView(id)}
                aria-pressed={view === id}
                title={id === 'grid' ? t('projects.viewGrid') : t('projects.viewList')}
                aria-label={id === 'grid' ? t('projects.viewGrid') : t('projects.viewList')}
                className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                  view === id
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                }`}
              >
                {id === 'grid' ? (
                  <LayoutGrid className="h-3.5 w-3.5" />
                ) : (
                  <ListIcon className="h-3.5 w-3.5" />
                )}
              </button>
            ))}
          </div>

          <span className="ml-auto text-[11px] text-text-muted">
            {t('projects.countSummary', { count: cards.length })}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {cards.length === 0 ? (
          <div className="mx-auto max-w-md py-16 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border-subtle bg-surface shadow-premium">
              <FolderOpen className="h-5 w-5 text-text-muted" />
            </div>
            <p className="mt-4 text-sm text-text-secondary">
              {projects.length === 0 ? t('projects.emptyHint') : t('projects.noMatch')}
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              {projects.length === 0 ? (
                <button
                  onClick={() => openProjectsModal(null)}
                  className="btn btn-primary px-3.5 py-2 text-[13px]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>{t('projects.newTitle')}</span>
                </button>
              ) : (
                <button
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                  className="btn btn-secondary px-3.5 py-2 text-[13px]"
                >
                  {t('projects.clearFilters')}
                </button>
              )}
            </div>
          </div>
        ) : view === 'grid' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map(({ project, lastActivity, hasPinned, sessionCount, fileCount }) => (
              <ProjectGridCard
                key={project.id}
                project={project}
                lastActivity={lastActivity}
                hasPinned={hasPinned}
                sessionCount={sessionCount}
                fileCount={fileCount}
                actions={renderActions(project, () => openProjectsModal(project.id))}
                onOpen={() => openProjectDetail(project.id)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {cards.map(({ project, lastActivity, hasPinned, sessionCount, fileCount }) => (
              <ProjectListRow
                key={project.id}
                project={project}
                lastActivity={lastActivity}
                hasPinned={hasPinned}
                sessionCount={sessionCount}
                fileCount={fileCount}
                actions={renderActions(project, () => openProjectsModal(project.id))}
                onOpen={() => openProjectDetail(project.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ProjectCardProps {
  project: Project;
  lastActivity: number;
  hasPinned: boolean;
  sessionCount: number;
  fileCount: number;
  actions: ReactNode;
  onOpen: () => void;
}

function ProjectGridCard({
  project,
  lastActivity,
  hasPinned,
  sessionCount,
  fileCount,
  actions,
  onOpen,
}: ProjectCardProps) {
  const { t, i18n } = useTranslation();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={project.name}
      className={`group card relative flex cursor-pointer flex-col p-4 text-left transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        project.archived ? 'opacity-70' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <ProjectAvatar project={project} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold text-text-primary">
              {project.name}
            </span>
            {hasPinned && (
              <span title={t('sidebar.pinned')} className="flex-shrink-0">
                <Pin className="h-3 w-3 -rotate-45 text-accent" />
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {project.archived && (
              <span className="badge bg-surface-active text-text-muted">
                {t('projects.archivedTag')}
              </span>
            )}
            {project.configSetId && (
              <span className="badge bg-accent/15 text-accent">{t('projects.configSetShort')}</span>
            )}
          </div>
        </div>
        {actions}
      </div>

      <p
        className={`mt-3 text-[12px] leading-5 ${
          project.description ? 'line-clamp-2 text-text-secondary' : 'italic text-text-muted'
        }`}
      >
        {project.description || t('projects.noDescription')}
      </p>

      <div
        className="mt-3 inline-flex max-w-full items-center gap-1.5 self-start rounded-lg bg-background/60 px-2 py-1 text-[11px] text-text-muted"
        title={project.workdir}
      >
        <FolderOpen className="h-3 w-3 flex-shrink-0" />
        <span className="truncate">{folderName(project.workdir)}</span>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-[11px] text-text-muted">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">
            {sessionCount > 0
              ? t('projects.cardSessionCount', { count: sessionCount })
              : t('projects.noSessionsInProject')}
          </span>
          {fileCount > 0 && (
            <span className="inline-flex flex-shrink-0 items-center gap-1 border-l border-border-muted pl-2">
              <Files className="h-3 w-3" />
              {t('projects.fileCount', { count: fileCount })}
            </span>
          )}
        </span>
        <span className="flex-shrink-0" title={formatDate(lastActivity, i18n.language)}>
          {formatRelativeTime(lastActivity, i18n.language)}
        </span>
      </div>
    </div>
  );
}

function ProjectListRow({
  project,
  lastActivity,
  hasPinned,
  sessionCount,
  fileCount,
  actions,
  onOpen,
}: ProjectCardProps) {
  const { t, i18n } = useTranslation();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={project.name}
      className={`group card flex cursor-pointer items-center gap-4 p-3 text-left transition-all hover:border-accent/40 hover:shadow-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        project.archived ? 'opacity-70' : ''
      }`}
    >
      <ProjectAvatar project={project} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-text-primary">
            {project.name}
          </span>
          {hasPinned && (
            <span title={t('sidebar.pinned')} className="flex-shrink-0">
              <Pin className="h-3 w-3 -rotate-45 text-accent" />
            </span>
          )}
          {project.archived && (
            <span className="badge bg-surface-active text-text-muted">
              {t('projects.archivedTag')}
            </span>
          )}
          {project.configSetId && (
            <span className="badge bg-accent/15 text-accent">{t('projects.configSetShort')}</span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[12px] text-text-secondary">
          {project.description || t('projects.noDescription')}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
          <span className="inline-flex min-w-0 items-center gap-1">
            <FolderOpen className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{folderName(project.workdir)}</span>
          </span>
          <span>{t('projects.cardSessionCount', { count: sessionCount })}</span>
          {fileCount > 0 && <span>{t('projects.fileCount', { count: fileCount })}</span>}
          <span title={formatDate(lastActivity, i18n.language)}>
            {formatRelativeTime(lastActivity, i18n.language)}
          </span>
        </div>
      </div>
      {actions}
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
  const openProjectsModal = useAppStore((s) => s.openProjectsModal);
  const { startSession, getSessionMessages, getSessionTraceSteps, togglePinSession, isElectron } =
    useIPC();

  const project = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);

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
  const [archiving, setArchiving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkSearch, setLinkSearch] = useState('');

  // Conversations not yet attached to any project — candidates the user can
  // add to this project. Sessions already in a (possibly other) project are
  // excluded: membership is single, shown as a move in the sidebar.
  const linkableSessions = useMemo(
    () =>
      sessions
        .filter((s) => !s.projectId)
        .filter((s) =>
          linkSearch.trim()
            ? s.title.toLowerCase().includes(linkSearch.trim().toLowerCase())
            : true
        )
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)),
    [sessions, linkSearch]
  );

  const linkExistingSession = useCallback(
    async (sessionId: string) => {
      setLinking(true);
      setError(null);
      try {
        const result = await window.electronAPI.projects.linkSession(projectId, sessionId);
        if (!result.success) {
          setError(result.error || t('projects.errors.linkFailed'));
          return;
        }
        useAppStore.getState().updateSession(sessionId, { projectId });
        setLinkPickerOpen(false);
        setLinkSearch('');
      } catch (err) {
        setError(err instanceof Error ? err.message : t('projects.errors.linkFailed'));
      } finally {
        setLinking(false);
      }
    },
    [projectId, t]
  );

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

  const visibleFiles = (project?.referenceFiles ?? []).filter((f) =>
    f.toLowerCase().includes(fileSearch.trim().toLowerCase())
  );

  const groupedFiles = useMemo(() => {
    const groups: Array<{ kind: FileKind; label: string; files: string[] }> = [
      { kind: 'image', label: t('projects.fileTypeImages'), files: [] },
      { kind: 'code', label: t('projects.fileTypeCode'), files: [] },
      { kind: 'doc', label: t('projects.fileTypeDocs'), files: [] },
    ];
    for (const filePath of visibleFiles) {
      const kind = fileKind(filePath);
      const group = groups.find((g) => g.kind === kind) ?? groups[2];
      group.files.push(filePath);
    }
    return groups.filter((g) => g.files.length > 0);
  }, [visibleFiles, t]);

  if (!project) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background">
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
  const lastActivity =
    projectSessions.reduce((max, s) => Math.max(max, s.updatedAt || s.createdAt), 0) ||
    project.updatedAt;

  const handleStartSession = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setStarting(true);
    setError(null);
    try {
      const sessionTitle = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
      const session = await startSession(
        sessionTitle,
        [{ type: 'text', text: trimmed }],
        project.workdir,
        project.id
      );
      setPrompt('');
      if (session) closeProjectsPage();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.errors.saveFailed'));
    } finally {
      setStarting(false);
    }
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

  // Archive/restore straight from the page: the editor modal is not the only
  // place that must be able to shelve a project.
  const toggleArchive = async () => {
    setArchiving(true);
    setError(null);
    try {
      const result = await window.electronAPI.projects.archive(project.id, !project.archived);
      if (!result.success) {
        setError(result.error || t('projects.errors.archiveFailed'));
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.errors.archiveFailed'));
    } finally {
      setArchiving(false);
    }
  };

  const copyWorkdir = async () => {
    // copyTextToClipboard falls back to execCommand under file:// + sandbox;
    // the checkmark only shows when the copy really landed.
    if (await copyTextToClipboard(project.workdir)) {
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 1500);
    }
  };

  const renderSessionRow = (session: Session) => (
    <div
      key={session.id}
      className="group/row flex items-center gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-surface-hover/60"
    >
      <span
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${STATUS_TONE[session.status]}`}
        title={t(STATUS_LABEL[session.status])}
        aria-label={t(STATUS_LABEL[session.status])}
      />
      <button
        onClick={() => void openSession(session.id)}
        className="min-w-0 flex-1 text-left"
        title={t('projects.openConversation')}
      >
        <span className="block truncate text-[13px] text-text-primary">{session.title}</span>
      </button>
      <span
        className="flex-shrink-0 text-[11px] text-text-muted"
        title={formatDate(session.updatedAt || session.createdAt, i18n.language)}
      >
        {formatRelativeTime(session.updatedAt || session.createdAt, i18n.language)}
      </span>
      <button
        onClick={() => togglePinSession(session.id, !session.isPinned)}
        className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-surface-hover ${
          session.isPinned
            ? 'text-accent'
            : 'text-text-muted opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'
        }`}
        title={session.isPinned ? t('projects.unpinSession') : t('projects.pinSession')}
        aria-label={session.isPinned ? t('projects.unpinSession') : t('projects.pinSession')}
      >
        <Pin className="h-3 w-3 -rotate-45" />
      </button>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 px-8 pb-3 pt-5">
        <button
          onClick={closeProjectsPage}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          title={t('projects.backToList')}
          aria-label={t('projects.backToList')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          onClick={openProjectsList}
          className="text-[13px] text-text-secondary transition-colors hover:text-text-primary"
        >
          {t('projects.sidebarSection')}
        </button>
        <span className="text-[13px] text-text-muted">/</span>
        <span className="truncate text-[13px] font-medium text-text-primary">{project.name}</span>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Main column */}
        <div className="min-w-0 flex-1 overflow-y-auto px-8 pb-8">
          {/* Header: identity, workspace chip, quick actions */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <ProjectAvatar project={project} size="lg" />
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-[-0.03em] text-text-primary">
                  {project.name}
                </h1>
                <div className="accent-underline mt-2 w-14" />
                {project.description && (
                  <p className="mt-2 max-w-[42rem] text-[13px] leading-5 text-text-secondary">
                    {project.description}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => void copyWorkdir()}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-2 py-1 text-[11px] text-text-muted transition-colors hover:border-border hover:text-text-secondary"
                    title={project.workdir}
                  >
                    <FolderOpen className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{project.workdir}</span>
                    {copiedPath ? (
                      <Check className="h-3 w-3 flex-shrink-0 text-success" />
                    ) : (
                      <Copy className="h-3 w-3 flex-shrink-0" />
                    )}
                    <span className="sr-only">{t('projects.copyPath')}</span>
                  </button>
                  {copiedPath && (
                    <span className="text-[11px] text-success">{t('projects.pathCopied')}</span>
                  )}
                  {project.archived && (
                    <span className="badge bg-surface-active text-text-muted">
                      {t('projects.archivedTag')}
                    </span>
                  )}
                  {project.configSetId && (
                    <span className="badge bg-accent/15 text-accent">
                      {t('projects.configSetShort')}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => openProjectsModal(project.id)}
                className="btn btn-secondary px-3 py-2 text-[12px]"
              >
                <Pencil className="h-3.5 w-3.5" />
                <span>{t('projects.editTitle')}</span>
              </button>
              <button
                onClick={() => void toggleArchive()}
                disabled={archiving}
                className="btn btn-ghost px-3 py-2 text-[12px]"
              >
                {archiving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : project.archived ? (
                  <ArchiveRestore className="h-3.5 w-3.5" />
                ) : (
                  <Archive className="h-3.5 w-3.5" />
                )}
                <span>{project.archived ? t('projects.restore') : t('projects.archive')}</span>
              </button>
            </div>
          </div>

          {/* Stats strip — the same figures the sections below drill into */}
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: t('projects.statsSessions'), value: String(projectSessions.length) },
              { label: t('projects.statsFiles'), value: String(project.referenceFiles.length) },
              { label: t('projects.statsContext'), value: `${percent}%` },
              {
                label: t('projects.lastActivity'),
                value: formatRelativeTime(lastActivity, i18n.language),
              },
            ].map((tile) => (
              <div
                key={tile.label}
                className="rounded-xl border border-border-subtle bg-surface px-3 py-2 shadow-premium"
              >
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                  {tile.label}
                </p>
                <p className="mt-1 truncate text-[15px] font-semibold tabular-nums text-text-primary">
                  {tile.value}
                </p>
              </div>
            ))}
          </div>

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
                className="max-h-[40vh] min-w-0 flex-1 resize-none overflow-y-auto border-none bg-transparent px-2 py-1.5 text-[14px] leading-relaxed text-text-primary outline-none placeholder:text-text-muted"
              />
              <button
                onClick={() => void handleStartSession()}
                disabled={!prompt.trim() || starting}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
                title={t('chat.sendMessage')}
              >
                {starting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
            <p className="px-2 pb-1 text-[11px] text-text-muted">
              {t('projects.newConversationHint')}
            </p>
          </div>

          {/* Pinned sessions of this project */}
          {pinnedSessions.length > 0 && (
            <section className="mt-7">
              <h2 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-text-primary">
                <Pin className="h-3 w-3 -rotate-45 text-accent" />
                {t('sidebar.pinned')}
              </h2>
              <div className="space-y-0.5">{pinnedSessions.map(renderSessionRow)}</div>
            </section>
          )}

          {/* Recent sessions of this project */}
          <section className="mt-7">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <h2 className="text-[13px] font-semibold text-text-primary">
                {t('projects.sectionConversations')}
              </h2>
              <button
                onClick={() => setLinkPickerOpen((prev) => !prev)}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                title={t('projects.addExistingConversation')}
                aria-expanded={linkPickerOpen}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{t('projects.addExisting')}</span>
              </button>
            </div>
            {linkPickerOpen && (
              <div className="mb-2 rounded-xl border border-border-subtle bg-surface/60 p-2">
                <div className="flex items-center gap-2 rounded-lg bg-background px-2 py-1.5">
                  <Search className="h-3.5 w-3.5 flex-shrink-0 text-text-muted" />
                  <input
                    value={linkSearch}
                    onChange={(e) => setLinkSearch(e.target.value)}
                    placeholder={t('projects.searchUnassigned')}
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
                  />
                </div>
                <div className="mt-1 max-h-48 overflow-y-auto">
                  {linkableSessions.length === 0 ? (
                    <p className="px-2 py-3 text-center text-[12px] text-text-muted">
                      {t('projects.noUnassignedSessions')}
                    </p>
                  ) : (
                    linkableSessions.slice(0, 20).map((s) => (
                      <button
                        key={s.id}
                        onClick={() => void linkExistingSession(s.id)}
                        disabled={linking}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-text-primary transition-colors hover:bg-surface-hover disabled:opacity-50"
                        title={s.title}
                      >
                        <Plus className="h-3 w-3 flex-shrink-0 text-text-muted" />
                        <span className="min-w-0 flex-1 truncate">{s.title}</span>
                        <span className="flex-shrink-0 text-[11px] text-text-muted">
                          {formatRelativeTime(s.updatedAt || s.createdAt, i18n.language)}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
            {recentSessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border-muted bg-surface/40 px-4 py-6 text-center">
                <p className="text-[12px] text-text-muted">{t('projects.noSessionsInProject')}</p>
              </div>
            ) : (
              <div className="space-y-0.5">{recentSessions.map(renderSessionRow)}</div>
            )}
          </section>
        </div>

        {/* Side column */}
        <aside className="w-[340px] flex-shrink-0 space-y-5 overflow-y-auto border-l border-border-muted p-6">
          {/* Instructions */}
          <section>
            <SectionHeading
              title={t('projects.instructions')}
              action={
                !editingInstructions && (
                  <button
                    onClick={() => {
                      setInstructionsDraft(project.instructions ?? '');
                      setEditingInstructions(true);
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
                    title={t('projects.editInstructions')}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )
              }
            />
            {editingInstructions ? (
              <div>
                <textarea
                  value={instructionsDraft}
                  onChange={(e) => setInstructionsDraft(e.target.value)}
                  rows={8}
                  autoFocus
                  className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                />
                <div className="mt-1 flex items-center justify-between text-[10px] text-text-muted">
                  <span>{t('projects.characters', { count: instructionsDraft.length })}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => {
                      setInstructionsDraft(project.instructions ?? '');
                      setEditingInstructions(false);
                    }}
                    className="flex-1 rounded-lg px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={() => void saveInstructions()}
                    disabled={savingInstructions}
                    className="flex-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
                  >
                    {savingInstructions ? t('projects.saving') : t('projects.save')}
                  </button>
                </div>
              </div>
            ) : project.instructions ? (
              <p className="line-clamp-6 whitespace-pre-wrap text-[12px] leading-5 text-text-secondary">
                {project.instructions}
              </p>
            ) : (
              <button
                onClick={() => {
                  setInstructionsDraft('');
                  setEditingInstructions(true);
                }}
                className="w-full rounded-xl border border-dashed border-border-muted px-3 py-4 text-left text-[12px] text-text-muted transition-colors hover:border-accent/40 hover:text-text-secondary"
              >
                <Sparkles className="mb-1 h-3.5 w-3.5" />
                <span className="block">{t('projects.noInstructions')}</span>
              </button>
            )}
          </section>

          {/* Context (reference files) */}
          <section>
            <SectionHeading
              title={t('projects.context')}
              action={
                <button
                  onClick={() => void attachFiles()}
                  disabled={attaching}
                  className="flex h-6 w-6 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
                  title={t('projects.attachFile')}
                >
                  {attaching ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                </button>
              }
            />

            {/* Real injection-budget ring + breakdown */}
            <div className="rounded-xl border border-border-subtle bg-surface p-3 shadow-premium">
              <div className="flex items-center gap-3">
                <div className="relative flex-shrink-0">
                  <CapacityRing percent={percent} />
                  <span className="absolute inset-0 flex items-center justify-center text-[13px] font-semibold tabular-nums text-text-primary">
                    {percent}%
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-text-primary">
                    {t('projects.capacityTitle')}
                  </p>
                  <p className="mt-0.5 text-[11px] text-text-muted">
                    {t('projects.capacityUsed', { percent })}
                  </p>
                </div>
              </div>
              {usage && (
                <dl className="mt-3 space-y-1 border-t border-border-muted pt-2 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-text-muted">{t('projects.breakdownInstructions')}</dt>
                    <dd className="tabular-nums text-text-secondary">
                      {formatNumber(usage.instructionsChars, i18n.language)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-text-muted">{t('projects.breakdownFiles')}</dt>
                    <dd className="tabular-nums text-text-secondary">
                      {formatNumber(usage.filesChars, i18n.language)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-text-muted">{t('projects.breakdownInjected')}</dt>
                    <dd className="tabular-nums text-text-secondary">
                      {t('projects.filesInjectedRatio', {
                        injected: usage.filesInjected,
                        total: usage.filesTotal,
                      })}
                    </dd>
                  </div>
                </dl>
              )}
              {usage && usage.filesTotal > usage.filesInjected && (
                <p className="mt-2 text-[11px] text-warning">
                  {t('projects.filesBeyondBudget', {
                    count: usage.filesTotal - usage.filesInjected,
                  })}
                </p>
              )}
            </div>

            {/* Thumbnails, grouped by kind */}
            {project.referenceFiles.length > 0 && (
              <div className="mt-3">
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" />
                  <input
                    type="text"
                    value={fileSearch}
                    onChange={(e) => setFileSearch(e.target.value)}
                    placeholder={t('projects.searchFiles')}
                    aria-label={t('projects.searchFiles')}
                    className="w-full rounded-lg border border-transparent bg-background/60 py-1.5 pl-7 pr-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-border focus:outline-none"
                  />
                </div>
                {groupedFiles.length === 0 ? (
                  <p className="text-[11px] text-text-muted">{t('projects.noMatch')}</p>
                ) : (
                  <div className="space-y-3">
                    {groupedFiles.map((group) => (
                      <div key={group.kind}>
                        <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                          <FileKindIcon kind={group.kind} className="h-3 w-3" />
                          {group.label}
                          <span className="tabular-nums">· {group.files.length}</span>
                        </p>
                        <div className="grid grid-cols-3 gap-2">
                          {group.files.map((filePath) => {
                            const fileName = filePath.split('/').pop() || filePath;
                            const isImage = isImagePath(filePath);
                            const isCode = isCodePath(filePath);
                            const Icon = isImage ? ImageIcon : isCode ? FileCode : FileText;
                            return (
                              <div
                                key={filePath}
                                className="group/file relative flex flex-col items-center gap-1 rounded-xl border border-border-muted bg-surface/60 p-2"
                                title={filePath}
                              >
                                <button
                                  onClick={() => void detachFile(filePath)}
                                  className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-error text-white group-hover/file:flex"
                                  title={t('projects.removeFile')}
                                  aria-label={t('projects.removeFile')}
                                >
                                  <X className="h-2.5 w-2.5" />
                                </button>
                                <Icon className="h-5 w-5 text-text-secondary" />
                                <span className="w-full truncate text-center text-[10px] text-text-secondary">
                                  {fileName}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {project.referenceFiles.length === 0 && (
              <button
                onClick={() => void attachFiles()}
                disabled={attaching}
                className="mt-3 w-full rounded-xl border border-dashed border-border-muted px-3 py-4 text-[12px] text-text-muted transition-colors hover:border-accent/40 hover:text-text-secondary disabled:opacity-50"
              >
                <Plus className="mx-auto mb-1 h-3.5 w-3.5" />
                <span className="block">{t('projects.noReferenceFiles')}</span>
              </button>
            )}
          </section>

          {/* Project metadata */}
          <section>
            <SectionHeading title={t('projects.statsCreated')} />
            <dl className="space-y-1.5 rounded-xl border border-border-subtle bg-surface px-3 py-2.5 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-text-muted">{t('projects.statsCreated')}</dt>
                <dd className="text-text-secondary">
                  {t('projects.createdOn', { date: formatDate(project.createdAt, i18n.language) })}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-text-muted">{t('projects.lastActivity')}</dt>
                <dd className="text-text-secondary">{formatDate(lastActivity, i18n.language)}</dd>
              </div>
              {project.configSetId && (
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-text-muted">{t('projects.configSetShort')}</dt>
                  <dd className="truncate text-text-secondary">
                    {project.modelId || t('projects.configSetNone')}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          {error && (
            <p className="text-[12px] text-error" role="alert">
              {error}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
