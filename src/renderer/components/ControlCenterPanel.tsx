import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, FolderTree, ListChecks, RefreshCw, SquareTerminal, X } from 'lucide-react';
import type { ControlCenterSnapshot } from '../../shared/control-center-types';
import { ActivityFeed } from './ActivityFeed';
import { TaskQueuePane } from './TaskQueuePane';
import { TerminalPane } from './TerminalPane';
import { WorkspacePane } from './WorkspacePane';

type ControlCenterTab = 'activity' | 'workspace' | 'queue' | 'terminal';

const TABS: ControlCenterTab[] = ['activity', 'workspace', 'queue', 'terminal'];

const TAB_ICON: Record<ControlCenterTab, typeof Activity> = {
  activity: Activity,
  workspace: FolderTree,
  queue: ListChecks,
  terminal: SquareTerminal,
};

interface ControlCenterPanelProps {
  sessionId: string;
  onClose: () => void;
}

/**
 * Cowork 4.0 — Phase 6: the agent control center. It completes the four panes
 * the plan asks for: the conversation (ChatView), the plan/DAG
 * (PlanApprovalPanel), the tool activity (here) and the diff/evidence
 * (DiffPanel + checkpoints).
 */
export function ControlCenterPanel({ sessionId, onClose }: ControlCenterPanelProps) {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI?.controlCenter : undefined;
  const [tab, setTab] = useState<ControlCenterTab>('activity');
  const [snapshot, setSnapshot] = useState<ControlCenterSnapshot | null>(null);

  const refresh = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      setSnapshot(await api.snapshot(sessionId));
    } catch {
      setSnapshot(null);
    }
  }, [api, sessionId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const running = snapshot?.queue.filter((task) => task.status === 'running').length ?? 0;
  const unread = snapshot?.notifications.filter((item) => !item.acknowledged).length ?? 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">{t('controlCenter.title')}</h2>
          <p className="text-xs text-text-muted">{t('controlCenter.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label={t('controlCenter.refresh')}
            className="rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('controlCenter.close')}
            className="rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-6 py-2 text-[11px] text-text-muted">
        <span>
          {t('controlCenter.summary.workspace')}:{' '}
          <span className="font-mono">{snapshot?.workspaceRoot ?? t('controlCenter.none')}</span>
        </span>
        <span>
          {t('controlCenter.summary.branch')}:{' '}
          <span className="font-mono">{snapshot?.git?.branch ?? t('controlCenter.none')}</span>
        </span>
        <span>{t('controlCenter.summary.running', { count: running })}</span>
        <span className={unread > 0 ? 'text-amber-400' : undefined}>
          {t('controlCenter.summary.unread', { count: unread })}
        </span>
      </div>

      <nav className="flex items-center gap-1 border-b border-border-subtle px-6 py-2">
        {TABS.map((candidate) => {
          const Icon = TAB_ICON[candidate];
          return (
            <button
              key={candidate}
              type="button"
              aria-pressed={tab === candidate}
              onClick={() => setTab(candidate)}
              className={
                'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ' +
                (tab === candidate
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-border text-text-secondary hover:bg-surface-hover')
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {t('controlCenter.tab.' + candidate)}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {tab === 'activity' && <ActivityFeed sessionId={sessionId} />}
        {tab === 'workspace' && <WorkspacePane sessionId={sessionId} />}
        {tab === 'queue' && <TaskQueuePane sessionId={sessionId} />}
        {tab === 'terminal' && <TerminalPane sessionId={sessionId} />}
      </div>
    </div>
  );
}
