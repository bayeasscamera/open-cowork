import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Brain,
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

type ViewPanelId = 'modelRouting' | 'controlCenter' | 'memory' | 'plan';
type InspectorPanelId = 'delegatedTasks' | 'document' | 'diff';
type PanelId = ViewPanelId | InspectorPanelId;

const VIEW_IDS: ViewPanelId[] = ['modelRouting', 'controlCenter', 'memory', 'plan'];
const INSPECTOR_IDS: InspectorPanelId[] = ['delegatedTasks', 'document', 'diff'];

/** Fixed ⌘/Ctrl+1..7 mapping — stable even when session-gated items are hidden. */
const SHORTCUT_ORDER: PanelId[] = [...VIEW_IDS, ...INSPECTOR_IDS];
const SHORTCUT_KEYS = ['1', '2', '3', '4', '5', '6', '7'];

/** Panels that only make sense once a session exists. */
const SESSION_SCOPED: PanelId[] = ['controlCenter', 'memory', 'plan', 'diff'];

const isViewPanel = (id: PanelId): id is ViewPanelId =>
  (VIEW_IDS as PanelId[]).includes(id);

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
  onClick: () => void;
}

function DockButton({ icon: Icon, tooltip, active, badge, onClick }: DockButtonProps) {
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
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-white ring-2 ring-background">
          {badge}
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
 * badge. Opening one inspector closes the others so only a single side
 * panel is ever mounted.
 *
 * Every panel is reachable through ⌘/Ctrl+1..7 in dock order.
 */
export function PanelDock({ className = '' }: PanelDockProps) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const runningBackgroundTasks = useAppStore((s) => s.runningBackgroundTasks);

  const viewVisible: Record<ViewPanelId, boolean> = {
    modelRouting: useAppStore((s) => s.modelRoutingVisible),
    controlCenter: useAppStore((s) => s.controlCenterVisible),
    memory: useAppStore((s) => s.memoryPanelVisible),
    plan: useAppStore((s) => s.planPanelVisible),
  };
  const inspectorVisible: Record<InspectorPanelId, boolean> = {
    delegatedTasks: useAppStore((s) => s.delegatedTasksVisible),
    document: useAppStore((s) => s.documentPanelVisible),
    diff: useAppStore((s) => s.diffPanelVisible),
  };

  // Full-page views replace the chat surface, so opening one closes the
  // others instead of leaving hidden flags stacked behind the ternary.
  const toggleViewPanel = useCallback((id: ViewPanelId) => {
    const state = useAppStore.getState();
    const current: Record<ViewPanelId, boolean> = {
      modelRouting: state.modelRoutingVisible,
      controlCenter: state.controlCenterVisible,
      memory: state.memoryPanelVisible,
      plan: state.planPanelVisible,
    };
    const open = !current[id];
    state.setModelRoutingVisible(open && id === 'modelRouting');
    state.setControlCenterVisible(open && id === 'controlCenter');
    state.setMemoryPanelVisible(open && id === 'memory');
    state.setPlanPanelVisible(open && id === 'plan');
  }, []);

  // Side inspectors share the right column: only one is mounted at a time.
  const setInspectorOpen = useCallback((id: InspectorPanelId, open: boolean) => {
    const state = useAppStore.getState();
    state.setDelegatedTasksVisible(open && id === 'delegatedTasks');
    state.setDocumentPanelVisible(open && id === 'document');
    state.setDiffPanelVisible(open && id === 'diff');
  }, []);

  const toggleInspectorPanel = useCallback(
    (id: InspectorPanelId) => {
      const state = useAppStore.getState();
      const current: Record<InspectorPanelId, boolean> = {
        delegatedTasks: state.delegatedTasksVisible,
        document: state.documentPanelVisible,
        diff: state.diffPanelVisible,
      };
      setInspectorOpen(id, !current[id]);
    },
    [setInspectorOpen]
  );

  // ⌘/Ctrl+1..7 — same toggles as the buttons, fixed positions so the
  // shortcuts never shift when a session-gated item appears or disappears.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const shortcutIndex = SHORTCUT_KEYS.indexOf(event.key);
      if (shortcutIndex === -1) return;
      const id = SHORTCUT_ORDER[shortcutIndex];
      const state = useAppStore.getState();
      if (SESSION_SCOPED.includes(id) && !state.activeSessionId) return;
      event.preventDefault();
      if (isViewPanel(id)) {
        toggleViewPanel(id);
      } else {
        toggleInspectorPanel(id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleViewPanel, toggleInspectorPanel]);

  interface DockItem<T extends PanelId = PanelId> {
    id: T;
    icon: LucideIcon;
    label: string;
    requiresSession: boolean;
    shortcut: number;
  }

  const viewItems: Array<DockItem<ViewPanelId>> = (
    [
      { id: 'modelRouting', icon: Route, label: t('modelRouting.short'), requiresSession: false },
      { id: 'controlCenter', icon: Gauge, label: t('controlCenter.short'), requiresSession: true },
      { id: 'memory', icon: Brain, label: t('memory.title'), requiresSession: true },
      { id: 'plan', icon: ListChecks, label: t('planPanel.title'), requiresSession: true },
    ] as Array<DockItem<ViewPanelId>>
  ).map((item) => ({ ...item, shortcut: SHORTCUT_ORDER.indexOf(item.id) + 1 }));

  const inspectorItems: Array<DockItem<InspectorPanelId>> = (
    [
      { id: 'delegatedTasks', icon: Users, label: t('delegatedTasks.title'), requiresSession: false },
      { id: 'document', icon: FileText, label: t('documentPanel.title'), requiresSession: false },
      { id: 'diff', icon: FileDiff, label: t('diffPanel.title'), requiresSession: true },
    ] as Array<DockItem<InspectorPanelId>>
  ).map((item) => ({ ...item, shortcut: SHORTCUT_ORDER.indexOf(item.id) + 1 }));

  const visibleItems = <T extends { requiresSession: boolean }>(items: T[]): T[] =>
    items.filter((item) => !item.requiresSession || Boolean(activeSessionId));

  const tooltipFor = (item: DockItem): string =>
    t('panelDock.shortcut', { label: item.label, key: shortcutLabel(item.shortcut) });

  const views = visibleItems(viewItems);
  const inspectors = visibleItems(inspectorItems);
  const sessionTasks = runningBackgroundTasks.filter(
    (task) => task.sessionId === activeSessionId
  );

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
        {views.map((item) => (
          <DockButton
            key={item.id}
            icon={item.icon}
            tooltip={tooltipFor(item)}
            active={viewVisible[item.id]}
            onClick={() => toggleViewPanel(item.id)}
          />
        ))}
        {views.length > 0 && inspectors.length > 0 && (
          <span className="mx-0.5 h-4 w-px bg-border-subtle" aria-hidden="true" />
        )}
        {inspectors.map((item) => (
          <DockButton
            key={item.id}
            icon={item.icon}
            tooltip={tooltipFor(item)}
            active={inspectorVisible[item.id]}
            badge={item.id === 'delegatedTasks' ? sessionTasks.length : undefined}
            onClick={() => toggleInspectorPanel(item.id)}
          />
        ))}
      </div>
    </div>
  );
}
