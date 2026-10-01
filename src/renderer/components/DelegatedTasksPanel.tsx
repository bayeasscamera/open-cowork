import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileCode,
  FileText,
  Image as ImageIcon,
  RotateCcw,
  Send,
  Settings,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import { DelegationSettingsForm } from './settings/DelegationSettingsForm';
import type { BackgroundTask } from '../types';

/**
 * "Delegated tasks" tracking panel — list + live detail + actions + settings.
 * Refreshes on every background.task event (delegationsVersion) so running
 * tasks show live tool progress without polling.
 */

const STATUS_STYLE: Record<BackgroundTask['status'], string> = {
  running: 'bg-sky-500/15 text-sky-500 border-sky-500/30',
  completed: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
  failed: 'bg-red-500/15 text-red-400 border-red-500/30',
  cancelled: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
};

function durationLabel(task: BackgroundTask): string {
  const end = task.completedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Compact hierarchy-cost line: parent tokenUsage already includes rolled-up children. */
function tokenLabel(task: BackgroundTask): string {
  if (!task.tokenUsage) return '—';
  return `${task.tokenUsage.input.toLocaleString()} / ${task.tokenUsage.output.toLocaleString()}`;
}

function fileIcon(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return ImageIcon;
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'json', 'md', 'yaml', 'yml'].includes(ext)) return FileCode;
  return FileText;
}

export function DelegatedTasksPanel() {
  const { t, i18n } = useTranslation();
  const visible = useAppStore((s) => s.delegatedTasksVisible);
  const setVisible = useAppStore((s) => s.setDelegatedTasksVisible);
  const delegationsVersion = useAppStore((s) => s.delegationsVersion);
  const { isElectron } = useIPC();

  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redirectDraft, setRedirectDraft] = useState('');
  const [redirectNotice, setRedirectNotice] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!isElectron) return;
    const id = ++requestId.current;
    try {
      const result = await window.electronAPI.backgroundTasks.list();
      if (id === requestId.current && result.success) setTasks(result.tasks);
    } catch {
      // panel keeps its last snapshot
    }
  }, [isElectron]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
  }, [visible, delegationsVersion, refresh]);

  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [tasks, selectedId]
  );

  const counts = useMemo(
    () => ({
      running: tasks.filter((x) => x.status === 'running').length,
      completed: tasks.filter((x) => x.status === 'completed').length,
      failed: tasks.filter((x) => x.status === 'failed').length,
    }),
    [tasks]
  );

  if (!visible) return null;

  const handleCancel = async (taskId: string) => {
    const result = await window.electronAPI.backgroundTasks.cancel(taskId);
    if (!result.success) setError(result.error ?? t('delegatedTasks.actionsError'));
    void refresh();
  };

  const handleRetry = async (taskId: string) => {
    const result = await window.electronAPI.backgroundTasks.retry(taskId);
    if (!result.success) setError(result.error ?? t('delegatedTasks.actionsError'));
    void refresh();
  };

  const handleRedirect = async (taskId: string) => {
    const text = redirectDraft.trim();
    if (!text) return;
    setError(null);
    setRedirectNotice(null);
    const result = await window.electronAPI.backgroundTasks.redirect(taskId, text);
    if (result.success) {
      setRedirectDraft('');
      setRedirectNotice(t('delegatedTasks.redirectSent'));
    } else {
      // A refusal is surfaced verbatim: it is the user who must know that a
      // redirection was refused rather than silently delivered.
      setRedirectNotice(null);
      setError(result.error ?? t('delegatedTasks.actionsError'));
    }
  };

  const handleDelete = async (taskId: string) => {
    const result = await window.electronAPI.backgroundTasks.delete(taskId);
    if (!result.success) setError(result.error ?? t('delegatedTasks.actionsError'));
    if (selectedId === taskId) setSelectedId(null);
    void refresh();
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      {/* List column */}
      <div className="flex w-[190px] flex-shrink-0 flex-col border-r border-border-muted">
        <div className="flex items-center justify-between gap-1 px-2.5 py-2 border-b border-border-muted">
          <span className="min-w-0 truncate text-[11px] font-semibold text-text-primary">
            {t('delegatedTasks.title')}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setShowSettings((prev) => !prev)}
              className={`w-6 h-6 rounded-lg flex items-center justify-center transition-colors ${
                showSettings
                  ? 'text-accent bg-surface-hover'
                  : 'text-text-muted hover:text-text-primary hover:bg-surface-hover'
              }`}
              title={t('delegatedTasks.configure')}
            >
              <Settings className="w-3 h-3" />
            </button>
            <button
              onClick={() => setVisible(false)}
              className="w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
              title={t('common.close')}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>

        {showSettings && (
          <div className="border-b border-border-muted p-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-2">
              {t('delegatedTasks.settingsTitle')}
            </p>
            <DelegationSettingsForm compact />
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {tasks.map((task) => (
            <button
              key={task.id}
              onClick={() => setSelectedId(task.id)}
              className={`w-full rounded-lg px-2 py-1.5 text-left transition-colors ${
                selectedId === task.id ? 'bg-surface-hover' : 'hover:bg-surface-hover/60'
              }`}
            >
              <span className="block truncate text-[12px] text-text-primary">{task.title}</span>
              <span className="mt-0.5 flex items-center gap-1.5">
                {task.depth >= 2 && (
                  <span className="inline-block rounded-full border border-accent/40 px-1.5 py-px text-[9px] font-medium text-accent">
                    {t('delegatedTasks.depthBadge', { depth: task.depth })}
                  </span>
                )}
                <span
                  className={`inline-block rounded-full border px-1.5 py-px text-[9px] font-medium uppercase ${STATUS_STYLE[task.status]}`}
                >
                  {t(`delegatedTasks.status.${task.status}`)}
                </span>
                <span className="text-[10px] text-text-muted">
                  {durationLabel(task)}
                </span>
              </span>
            </button>
          ))}
          {tasks.length === 0 && (
            <p className="px-2 py-3 text-[11px] text-text-muted">{t('delegatedTasks.empty')}</p>
          )}
        </div>
      </div>

      {/* Detail column */}
      <div className="flex-1 min-w-0 overflow-y-auto p-3">
        {!selected ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <p className="text-[12px] text-text-muted">{t('delegatedTasks.selectHint')}</p>
            <p className="text-[11px] text-text-muted">
              {t('delegatedTasks.summaryCounts', counts)}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">
                  {selected.title}
                </h3>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${STATUS_STYLE[selected.status]}`}
                >
                  {t(`delegatedTasks.status.${selected.status}`)}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-text-muted">
                {t('delegatedTasks.meta', {
                  role: selected.role,
                  model: selected.modelUsed ?? '—',
                  duration: durationLabel(selected),
                  date: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(selected.startedAt),
                })}
              </p>
              <p className="mt-1 text-[11px] text-text-muted">
                {t('delegatedTasks.hierarchyDepth', { depth: selected.depth })}
                {' · '}
                {t('delegatedTasks.hierarchyCost', { tokens: tokenLabel(selected) })}
              </p>
            </div>

            {error && (
              <p className="text-[11px] text-red-400" role="alert">
                {error}
              </p>
            )}

            {/* Structured report when finished */}
            {selected.report && selected.status !== 'running' && (
              <div className="space-y-2">
                <section>
                  <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                    {t('delegatedTasks.report.summary')}
                  </h4>
                  <p className="mt-0.5 text-[12px] leading-5 whitespace-pre-wrap text-text-primary">
                    {selected.report.summary}
                  </p>
                </section>
                {selected.report.findings && (
                  <section>
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                      {t('delegatedTasks.report.findings')}
                    </h4>
                    <p className="mt-0.5 text-[12px] leading-5 whitespace-pre-wrap text-text-secondary">
                      {selected.report.findings}
                    </p>
                  </section>
                )}
                {selected.report.assumptions &&
                  !/^none$/i.test(selected.report.assumptions.trim()) && (
                    <section>
                      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-amber-500">
                        {t('delegatedTasks.report.assumptions')}
                      </h4>
                      <p className="mt-0.5 text-[12px] leading-5 whitespace-pre-wrap text-text-secondary">
                        {selected.report.assumptions}
                      </p>
                    </section>
                  )}
                {selected.report.limits && !/^none$/i.test(selected.report.limits.trim()) && (
                  <section>
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                      {t('delegatedTasks.report.limits')}
                    </h4>
                    <p className="mt-0.5 text-[12px] leading-5 whitespace-pre-wrap text-text-secondary">
                      {selected.report.limits}
                    </p>
                  </section>
                )}
                {selected.modifiedFiles && selected.modifiedFiles.length > 0 && (
                  <section>
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                      {t('delegatedTasks.report.files')}
                    </h4>
                    <ul className="mt-0.5 space-y-0.5">
                      {selected.modifiedFiles.map((file) => {
                        const Icon = fileIcon(file);
                        return (
                          <li key={file} className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                            <Icon className="w-3 h-3 flex-shrink-0" />
                            <span className="truncate" title={file}>
                              {file}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </div>
            )}

            {/* Live tool progress while running */}
            {selected.status === 'running' && (
              <section>
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  {t('delegatedTasks.liveProgress')}
                </h4>
                <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-text-secondary">
                  {selected.log
                    .slice(-12)
                    .map((entry, index) => (
                      <li key={`${entry.at}-${index}`} className="flex items-center gap-2">
                        <span className="text-text-muted">
                          {new Date(entry.at).toLocaleTimeString(i18n.language, { hour12: false })}
                        </span>
                        <span>
                          {entry.kind === 'tool' ? `→ ${entry.text}` : entry.text || entry.kind}
                        </span>
                      </li>
                    ))}
                </ul>
              </section>
            )}

            {/* Mid-task redirection — only while the task is running */}
            {selected.status === 'running' && (
              <section>
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  {t('delegatedTasks.redirectTitle')}
                </h4>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  {t('delegatedTasks.redirectHint')}
                </p>
                <textarea
                  value={redirectDraft}
                  onChange={(e) => setRedirectDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void handleRedirect(selected.id);
                    }
                  }}
                  rows={2}
                  maxLength={2000}
                  placeholder={t('delegatedTasks.redirectPlaceholder')}
                  className="mt-1.5 w-full resize-none rounded-lg border border-border bg-surface px-2 py-1.5 text-[12px] text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    onClick={() => void handleRedirect(selected.id)}
                    disabled={!redirectDraft.trim()}
                    className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-40 hover:bg-accent/90 transition-colors"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {t('delegatedTasks.actions.redirect')}
                  </button>
                  {redirectNotice && (
                    <span className="text-[11px] text-emerald-500">{redirectNotice}</span>
                  )}
                </div>
              </section>
            )}

            {selected.error && selected.status === 'failed' && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[11px] text-text-secondary">
                {selected.error}
              </p>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 border-t border-border-muted pt-2.5">
              {selected.status === 'running' && (
                <button
                  onClick={() => void handleCancel(selected.id)}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-text-secondary hover:text-red-400 hover:border-red-500/40 transition-colors"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  {t('delegatedTasks.actions.cancel')}
                </button>
              )}
              {(selected.status === 'failed' || selected.status === 'cancelled') && (
                <button
                  onClick={() => void handleRetry(selected.id)}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {t('delegatedTasks.actions.retry')}
                </button>
              )}
              {selected.status !== 'running' && (
                <button
                  onClick={() => void handleDelete(selected.id)}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-text-secondary hover:text-error hover:bg-surface-hover transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('delegatedTasks.actions.delete')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}