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

interface DockButtonProps {
  icon: LucideIcon;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}

function DockButton({ icon: Icon, label, active, badge, onClick }: DockButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
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
 */
export function PanelDock({ className = '' }: PanelDockProps) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const runningBackgroundTasks = useAppStore((s) => s.runningBackgroundTasks);

  const modelRoutingVisible = useAppStore((s) => s.modelRoutingVisible);
  const controlCenterVisible = useAppStore((s) => s.controlCenterVisible);
  const memoryPanelVisible = useAppStore((s) => s.memoryPanelVisible);
  const planPanelVisible = useAppStore((s) => s.planPanelVisible);
  const delegatedTasksVisible = useAppStore((s) => s.delegatedTasksVisible);
  const documentPanelVisible = useAppStore((s) => s.documentPanelVisible);
  const diffPanelVisible = useAppStore((s) => s.diffPanelVisible);

  const setModelRoutingVisible = useAppStore((s) => s.setModelRoutingVisible);
  const setControlCenterVisible = useAppStore((s) => s.setControlCenterVisible);
  const setMemoryPanelVisible = useAppStore((s) => s.setMemoryPanelVisible);
  const setPlanPanelVisible = useAppStore((s) => s.setPlanPanelVisible);
  const setDelegatedTasksVisible = useAppStore((s) => s.setDelegatedTasksVisible);
  const setDocumentPanelVisible = useAppStore((s) => s.setDocumentPanelVisible);
  const setDiffPanelVisible = useAppStore((s) => s.setDiffPanelVisible);

  const viewVisible: Record<ViewPanelId, boolean> = {
    modelRouting: modelRoutingVisible,
    controlCenter: controlCenterVisible,
    memory: memoryPanelVisible,
    plan: planPanelVisible,
  };
  const setViewVisible: Record<ViewPanelId, (visible: boolean) => void> = {
    modelRouting: setModelRoutingVisible,
    controlCenter: setControlCenterVisible,
    memory: setMemoryPanelVisible,
    plan: setPlanPanelVisible,
  };
  const inspectorVisible: Record<InspectorPanelId, boolean> = {
    delegatedTasks: delegatedTasksVisible,
    document: documentPanelVisible,
    diff: diffPanelVisible,
  };
  const setInspectorVisible: Record<InspectorPanelId, (visible: boolean) => void> = {
    delegatedTasks: setDelegatedTasksVisible,
    document: setDocumentPanelVisible,
    diff: setDiffPanelVisible,
  };

  // Full-page views replace the chat surface, so opening one closes the
  // others instead of leaving hidden flags stacked behind the ternary.
  const toggleViewPanel = (id: ViewPanelId) => {
    const open = !viewVisible[id];
    (Object.keys(setViewVisible) as ViewPanelId[]).forEach((key) => {
      setViewVisible[key](open && key === id);
    });
  };

  // Side inspectors share the right column: only one is mounted at a time.
  const setInspectorOpen = (id: InspectorPanelId, open: boolean) => {
    (Object.keys(setInspectorVisible) as InspectorPanelId[]).forEach((key) => {
      setInspectorVisible[key](open && key === id);
    });
  };

  const toggleInspectorPanel = (id: InspectorPanelId) => {
    setInspectorOpen(id, !inspectorVisible[id]);
  };

  const viewItems: Array<{
    id: ViewPanelId;
    icon: LucideIcon;
    label: string;
    requiresSession: boolean;
  }> = [
    { id: 'modelRouting', icon: Route, label: t('modelRouting.short'), requiresSession: false },
    { id: 'controlCenter', icon: Gauge, label: t('controlCenter.short'), requiresSession: true },
    { id: 'memory', icon: Brain, label: t('memory.title'), requiresSession: true },
    { id: 'plan', icon: ListChecks, label: t('planPanel.title'), requiresSession: true },
  ];

  const inspectorItems: Array<{
    id: InspectorPanelId;
    icon: LucideIcon;
    label: string;
    requiresSession: boolean;
  }> = [
    { id: 'delegatedTasks', icon: Users, label: t('delegatedTasks.title'), requiresSession: false },
    { id: 'document', icon: FileText, label: t('documentPanel.title'), requiresSession: false },
    { id: 'diff', icon: FileDiff, label: t('diffPanel.title'), requiresSession: true },
  ];

  const visibleItems = <T extends { requiresSession: boolean }>(items: T[]): T[] =>
    items.filter((item) => !item.requiresSession || Boolean(activeSessionId));

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
            label={item.label}
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
            label={item.label}
            active={inspectorVisible[item.id]}
            badge={item.id === 'delegatedTasks' ? sessionTasks.length : undefined}
            onClick={() => toggleInspectorPanel(item.id)}
          />
        ))}
      </div>
    </div>
  );
}
