import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Brain,
  Check,
  FileDiff,
  FileText,
  Gauge,
  ListChecks,
  Loader2,
  Route,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useAppStore } from '../store';
import {
  WORKSPACE_PANELS,
  type WorkspaceInspectorPanelId,
  type WorkspacePanelDescriptor,
  type WorkspacePanelId,
  type WorkspaceViewPanelId,
} from '../../shared/workspace-panels';
import { setInspectorOpen, toggleWorkspacePanel } from '../utils/workspace-panel-toggles';
import { BranchSelector } from './BranchSelector';

const PANEL_ICONS: Record<WorkspacePanelId, LucideIcon> = {
  modelRouting: Route,
  controlCenter: Gauge,
  memory: Brain,
  plan: ListChecks,
  delegatedTasks: Users,
  document: FileText,
  diff: FileDiff,
};

const isViewDescriptor = (
  panel: WorkspacePanelDescriptor
): panel is WorkspacePanelDescriptor & { id: WorkspaceViewPanelId } => panel.kind === 'view';

const isInspectorDescriptor = (
  panel: WorkspacePanelDescriptor
): panel is WorkspacePanelDescriptor & { id: WorkspaceInspectorPanelId } =>
  panel.kind === 'inspector';

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

const shortcutLabel = (index: number): string =>
  `${isMacPlatform() ? '⌘' : 'Ctrl+'}${index}`;

interface DockButtonProps {
  icon: LucideIcon;
  tooltip: string;
  active: boolean;
  badge?: number;
  flash?: boolean;
  onClick: () => void;
}

function DockButton({ icon: Icon, tooltip, active, badge, flash = false, onClick }: DockButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      aria-pressed={active}
      className={`relative flex h-8 w-8 items-center justify-center rounded-xl transition-colors duration-150 ${
        active
          ? 'bg-accent/10 text-accent'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
      }`}
    >
      <Icon className="h-4 w-4" />
      {badge !== undefined && (badge > 0 || flash) && (
        <span
          className={`absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none text-white ring-2 ring-background ${
            flash ? 'animate-badge-flash bg-success' : 'bg-accent'
          }`}
        >
          {badge > 0 ? badge : <Check className="h-2.5 w-2.5" aria-hidden="true" />}
        </span>
      )}
    </button>
  );
}

interface PanelDockProps {
  className?: string;
}

/**
 * Unified glass dock for every workspace panel: full-page views (model
 * routing, control center, memory, plan) and side inspectors (delegated
 * tasks, document, diff). One container, one interaction model: active
 * panels get the accent treatment, running delegated tasks surface as a
 * badge that flashes green (with a check) when one completes. Opening one
 * inspector closes the others so only a single side panel is ever mounted.
 *
 * Every panel is reachable through ⌘/Ctrl+1..7 in dock order.
 */
export function PanelDock({ className = '' }: PanelDockProps) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const runningBackgroundTasks = useAppStore((s) => s.runningBackgroundTasks);
  const notifyOnCompletion = useAppStore((s) => s.notifyOnCompletion);
  // The branch selector is only meaningful once a workspace is chosen; before
  // that there is no directory to run git in.
  const workingDir = useAppStore((s) => s.workingDir);

  const viewVisible: Record<WorkspaceViewPanelId, boolean> = {
    modelRouting: useAppStore((s) => s.modelRoutingVisible),
    controlCenter: useAppStore((s) => s.controlCenterVisible),
    memory: useAppStore((s) => s.memoryPanelVisible),
    plan: useAppStore((s) => s.planPanelVisible),
  };
  const inspectorVisible: Record<WorkspaceInspectorPanelId, boolean> = {
    delegatedTasks: useAppStore((s) => s.delegatedTasksVisible),
    document: useAppStore((s) => s.documentPanelVisible),
    diff: useAppStore((s) => s.diffPanelVisible),
  };

  // ⌘/Ctrl+1..7 — same toggles as the buttons, fixed positions so the
  // shortcuts never shift when a session-gated item appears or disappears.
  // Session gating and duplicate-press protection live in the shared entry
  // point so the app menu and the keyboard behave identically.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const panel = WORKSPACE_PANELS.find(
        (candidate) => String(candidate.shortcut) === event.key
      );
      if (!panel) return;
      if (toggleWorkspacePanel(panel.id)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const tooltipFor = (label: string, shortcut: number): string =>
    t('panelDock.shortcut', { label, key: shortcutLabel(shortcut) });

  const visiblePanels = WORKSPACE_PANELS.filter(
    (panel) => !panel.requiresSession || Boolean(activeSessionId)
  );
  const views = visiblePanels.filter(isViewDescriptor);
  const inspectors = visiblePanels.filter(isInspectorDescriptor);
  const sessionTasks = runningBackgroundTasks.filter(
    (task) => task.sessionId === activeSessionId
  );

  // Flash the badge when a delegated task leaves the running set (= completed).
  // Honours the same "Notify when a task finishes" gate as the toast and the
  // native notification, so switching notifications off silences all three.
  const [completedFlash, setCompletedFlash] = useState(false);
  const taskKey = sessionTasks
    .map((task) => task.taskId)
    .sort()
    .join(',');
  const previousTaskKey = useRef(taskKey);
  useEffect(() => {
    const previous = previousTaskKey.current;
    previousTaskKey.current = taskKey;
    const count = (value: string) => (value ? value.split(',').length : 0);
    if (previous !== taskKey && count(taskKey) < count(previous)) {
      if (!notifyOnCompletion) return;
      setCompletedFlash(true);
      const timer = setTimeout(() => setCompletedFlash(false), 1600);
      return () => clearTimeout(timer);
    }
  }, [taskKey, notifyOnCompletion]);

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      {sessionTasks.map((task) => (
        <button
          key={task.taskId}
          type="button"
          onClick={() => setInspectorOpen('delegatedTasks', true)}
          title={task.title}
          className="flex items-center gap-2 rounded-full border border-border-subtle bg-surface-muted px-3 py-1.5 text-xs text-text-secondary shadow-soft transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <Loader2 className="h-3 w-3 animate-spin text-accent" />
          <span className="max-w-[180px] truncate">{task.title}</span>
        </button>
      ))}
      <div
        role="toolbar"
        aria-label={t('panelDock.label')}
        className="panel-glass inline-flex items-center gap-0.5 rounded-2xl border border-border-subtle p-1 shadow-soft"
      >
        {views.map((panel) => (
          <DockButton
            key={panel.id}
            icon={PANEL_ICONS[panel.id]}
            tooltip={tooltipFor(t(panel.labelKey), panel.shortcut)}
            active={viewVisible[panel.id]}
            onClick={() => toggleWorkspacePanel(panel.id)}
          />
        ))}
        {views.length > 0 && inspectors.length > 0 && (
          <span className="mx-0.5 h-4 w-px bg-border-subtle" aria-hidden="true" />
        )}
        {inspectors.map((panel) => (
          <DockButton
            key={panel.id}
            icon={PANEL_ICONS[panel.id]}
            tooltip={tooltipFor(t(panel.labelKey), panel.shortcut)}
            active={inspectorVisible[panel.id]}
            badge={panel.id === 'delegatedTasks' ? sessionTasks.length : undefined}
            flash={panel.id === 'delegatedTasks' && completedFlash}
            onClick={() => toggleWorkspacePanel(panel.id)}
          />
        ))}
        {/* Branch selector sits after the panel toggles: it acts on the
            workspace rather than switching a view, so it is deliberately not
            part of the ⌘/Ctrl+1..7 sequence. */}
        {Boolean(workingDir) && (
          <span className="mx-0.5 h-4 w-px bg-border-subtle" aria-hidden="true" />
        )}
        <BranchSelector />
      </div>
    </div>
  );
}
